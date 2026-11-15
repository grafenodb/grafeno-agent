#!/usr/bin/env node
import { TASK_KINDS } from "./orchestrator/plan.js";
import { isAuto, KNOWN_PROVIDERS, providerForKinds, providerIds } from "./providers/index.js";
import type { Provider } from "./providers/types.js";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { SYSTEM_PROMPT } from "./agent/builtin-tools.js";
import { ToolRegistry } from "./agent/tools.js";
import { runChat } from "./chat.js";
import { ConfigError, describeConfig, loadConfig, type Config } from "./config.js";
import type { Embedder } from "./embed/types.js";
import { initSettings, loadSettings, settingsPath } from "./settings-file.js";
import { projectTools, toolsPrompt } from "./tools/index.js";
import { Workspace } from "./tools/workspace.js";
import { MemorySession, type Project } from "./memory/session.js";
import { detectProject } from "./memory/project.js";
import { describeUpkeep, upkeep } from "./memory/upkeep.js";
import { grafenoVault, type Vault } from "./memory/vault.js";
import { createModel } from "./model/index.js";
import { StartupError, checkGrafeno, type AgentIdentity } from "./startup.js";
import { embedderFor, prepareGrafeno, realServices } from "./app/services.js";
import { runTui } from "./tui/run.js";
import { createInterface } from "node:readline/promises";
import { createOrchestrator, describePlan, type OrchestrateSettings } from "./app/orchestrate.js";
import type { Orchestrator, OrchestratorOptions } from "./orchestrator/orchestrator.js";
import { AUTONOMY, type Autonomy } from "./orchestrator/policy.js";
import { describeReport } from "./orchestrator/telemetry.js";
import { describeResumeStats, resumeCompact } from "./app/resume.js";

const USAGE = `Usage: grafeno-agent <command>

Run it in the project you want help with.

Commands:
  chat     Talk with the agent (the default). In a terminal it opens the full
           interface; --plain (or piped input) talks line by line.
  init     Set up: --include-grafeno (Grafeno runs on this computer), or
           --grafeno-url <url> --key <key> (a Grafeno server you have).
  check    Check the settings, that Grafeno answers and that the agent's key works.
  version  Show the version.
  upkeep  Look after the project's memory: duplicates, contradictions, the palace's
          arrangement. Add --apply to carry out the safe fixes.
  run "<request>"  Plan the request and run it with several workers, each in its own
          git worktree; the work lands on an integration branch for you to merge.
          --mode supervised|controlled|extended (default controlled), --workers N
          (default 3), --light (light models, low effort), --yes (no confirmation),
          --providers claude-code,codex (default AGENT_PROVIDERS), or --providers auto
          (General Auto: every ready provider as one pool, each task kind to its
          affinity, AGENT_AFFINITY), --provider-for tests=codex,docs=codex (which
          provider takes a kind of task).
  runs [id]  The project's runs, or one run's report.
  resume <id>  Go on with a paused or waiting run.
  resume --compact  Print where the project's work stands, compact, for a new session:
          the latest checkpoint and a few related memories, within budgets. Only reads
          memory, calls no model. --task <name> (a task's checkpoints instead of the
          project's), --project <name>, --budget N (checkpoint tokens, default 500),
          --memory-budget N (default 500), --max-memories N (default 5), --json.
          --level 0 (the checkpoint alone), 1 (and related memories: the default),
          2 --query "<topic>" (memories about something specific). Measures go to
          stderr. Meant for a Claude Code SessionStart hook.
  router [--import]  What the router has learned: each kind of task and complexity, each
          provider, model and effort, how often it succeeded cleanly (with its 95%
          interval), cost and time, and whether the sample is big enough to count.
          --import first reads the runs already kept for every project.`;

/** Days between upkeeps before the chat suggests one. */
const UPKEEP_EVERY_DAYS = 7;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** The value after a flag: `--grafeno-url http://…`. */
function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Sets up the settings. `--include-grafeno` installs and starts Grafeno with
 * the agent; `--grafeno-url <url> [--key <key>]` uses a server the user has.
 * Without either, it writes the settings file to fill in (running
 * `grafeno-agent` in a terminal asks the same, with a guide).
 */
async function init(argv: readonly string[]): Promise<number> {
  const path = settingsPath();
  if (argv.includes("--include-grafeno")) {
    initSettings(path);
    const services = realServices(version());
    let shown = -1;
    const message = await services.includeGrafeno((done, total) => {
      const tenth = Math.floor((done / total) * 10);
      if (tenth > shown) {
        shown = tenth;
        process.stdout.write(`${String(tenth * 10)}% `);
      }
    });
    console.log(`\n${message}`);
    return 0;
  }
  const url = flag(argv, "--grafeno-url");
  if (url !== undefined) {
    initSettings(path);
    const key = flag(argv, "--key");
    const message = await realServices(version()).connectGrafeno({
      url,
      namespace: flag(argv, "--namespace") ?? process.env.GRAFENO_NAMESPACE ?? "grafeno-agent",
      ...(key === undefined ? {} : { key }),
    });
    console.log(message);
    return 0;
  }
  if (!initSettings(path)) {
    console.log(`The settings file is already there: ${path}`);
    return 0;
  }
  console.log(`Wrote ${path}\n`);
  console.log("Choose where the agent keeps its memory:\n");
  console.log("  grafeno-agent init --include-grafeno");
  console.log("      Include Grafeno: it is downloaded and runs on this computer.\n");
  console.log("  grafeno-agent init --grafeno-url http://127.0.0.1:7810 --key <key>");
  console.log("      A Grafeno server you already have. Its administrator makes the key:");
  console.log(
    "      grafeno keys create grafeno-agent --grant grafeno-agent:write --config <grafeno.toml>\n",
  );
  console.log("Or just run `grafeno-agent` in a terminal: it guides you through both.");
  return 0;
}

async function check(): Promise<number> {
  const config = loadConfig();
  await prepareGrafeno(config);
  const file = settingsPath();
  console.log(`settings:  ${file}${existsSync(file) ? "" : " (not there: grafeno-agent init)"}`);
  console.log(describeConfig(config));
  const report = await checkGrafeno(config);
  console.log(
    `\nGrafeno ${report.serverVersion} answers; the key works in "${report.namespace}" ` +
      `(${String(report.tools.length)} memory tools).`,
  );
  console.log(
    report.identity
      ? `The agent is "${report.identity.name}" (its key's name, recorded on what it writes)` +
          `${report.identity.ownOnly ? "; it may change only what it recorded" : ""}.`
      : "Grafeno did not say the key's name: the agent works as one, without a name of its own.",
  );
  return 0;
}

/** The memory session of a command, as the settings and the start-up check say. */
async function startMemory(
  config: Config,
  identity: AgentIdentity | undefined,
  embedder?: Embedder,
): Promise<{ memory: MemorySession; vault: Vault; project: Project }> {
  const vault = grafenoVault(config);
  const project = detectProject(process.cwd(), config.project);
  const memory = await MemorySession.start({
    vault,
    project,
    palace: config.palace,
    knownSecrets: [config.agentKey],
    ...(identity ? { agent: identity } : {}),
    ...(embedder ? { embedder } : {}),
  });
  return { memory, vault, project };
}

async function chat(plain: boolean): Promise<number> {
  // In a terminal, the full interface; piped or with --plain, line by line.
  if (!plain && process.stdin.isTTY && process.stdout.isTTY) {
    await runTui(realServices(version()));
    return 0;
  }
  const config = loadConfig();
  await prepareGrafeno(config);
  const { identity } = await checkGrafeno(config);
  const embedder = await embedderFor(config.embedder);
  const { memory, project } = await startMemory(config, identity, embedder);
  const memoryTools = await memory.tools();
  const last = await memory.lastUpkeep();
  if (!last || Date.now() - last.getTime() > UPKEEP_EVERY_DAYS * 86_400_000) {
    const when = last ? `last ran ${last.toISOString().slice(0, 10)}` : "has not run yet";
    console.log(`Memory upkeep ${when}: run \`grafeno-agent upkeep\`.`);
  }
  console.log(
    `Project: ${project.name} (memory: palace "${memory.palace}" in namespace "${config.namespace}"` +
      `${identity ? `; agent "${identity.name}"` : ""})`,
  );

  const model = createModel(config.model, {
    ...(config.claudeModel === undefined ? {} : { claudeModel: config.claudeModel }),
  });
  const workspace = new Workspace(project.path ?? process.cwd());
  const ownTools = projectTools(workspace, { hiddenEnv: ["GRAFENO_AGENT_KEY"] });
  const system = `${memory.systemPrompt(SYSTEM_PROMPT)}\n\n${toolsPrompt(workspace)}`;
  await runChat({
    input: process.stdin,
    output: process.stdout,
    endOfSession: memory.endOfSession(),
    makeAgent: (approve) =>
      new Agent({
        model,
        system,
        tools: new ToolRegistry([...ownTools, ...memoryTools], approve, {
          redact: [config.agentKey],
        }),
        prepare: (message) => memory.beforeTurn(message),
      }),
  });
  return 0;
}

async function runUpkeep(apply: boolean): Promise<number> {
  const config = loadConfig();
  await prepareGrafeno(config);
  const { identity } = await checkGrafeno(config);
  const { memory, vault, project } = await startMemory(config, identity);
  const report = await upkeep({ vault, palace: memory.palace, projectId: memory.projectId, apply });
  const mode = apply ? "" : " (report only; --apply carries out the safe fixes)";
  console.log(`Memory upkeep for ${project.name}${mode}:\n`);
  console.log(describeUpkeep(report));
  await memory.markUpkeep();
  return 0;
}

/** The run settings from the command line: --mode, --workers, --light. */
function runSettings(argv: readonly string[]): OrchestrateSettings {
  const mode = flag(argv, "--mode");
  if (mode !== undefined && !(AUTONOMY as readonly string[]).includes(mode)) {
    throw new Error(`--mode must be one of ${AUTONOMY.join(", ")}`);
  }
  const workers = Number(flag(argv, "--workers") ?? "3");
  return {
    ...(mode === undefined ? {} : { mode: mode as Autonomy }),
    workers: Number.isFinite(workers) && workers >= 1 ? Math.floor(workers) : 3,
    light: argv.includes("--light"),
    ...(flag(argv, "--provider-for") === undefined
      ? {}
      : { providerFor: providerForKinds(flag(argv, "--provider-for"), TASK_KINDS) }),
    ...(flag(argv, "--providers") === undefined
      ? {}
      : {
          providers: providerIds(flag(argv, "--providers")).map((id) =>
            (KNOWN_PROVIDERS[id] as () => Provider)(),
          ),
          ...(isAuto(flag(argv, "--providers")) ? { auto: true } : {}),
        }),
  };
}

/** Asks a yes/no question on the terminal; no when there is no terminal. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await lines.question(`${question} [y/N] `);
    return /^(y|yes|s|si|sí)$/i.test(answer.trim());
  } finally {
    lines.close();
  }
}

/** Runs a run to where it stops, printing what happens. */
async function drive(orchestrator: Orchestrator, runId: string): Promise<number> {
  const state = await orchestrator.run(runId);
  console.log("");
  for (const line of describeReport(orchestrator.report(runId))) console.log(line);
  if (state === "completed") {
    const branch = orchestrator.integrationBranch(runId);
    console.log(
      `\nThe work is on the branch ${branch}. Look at it, then merge it when you are ready:`,
    );
    console.log(`  git diff HEAD...${branch}`);
    console.log(`  git merge ${branch}`);
  } else if (state === "paused" || state === "waiting") {
    console.log(`\nThe run is ${state}. Go on with: grafeno-agent resume ${runId}`);
  }
  orchestrator.close();
  return state === "completed" ? 0 : 1;
}

function printChanges(): Pick<OrchestratorOptions, "onChange"> {
  return {
    onChange: (change) => {
      if (change.type === "task") {
        console.log(
          `  ${change.task.padEnd(22)} ${change.state}${change.reason ? `  ${change.reason.split("\n", 1)[0] ?? ""}` : ""}`,
        );
      }
    },
  };
}

async function orchestrateCommand(argv: readonly string[]): Promise<number> {
  const request = argv
    .filter(
      (arg, i) =>
        !arg.startsWith("--") &&
        !["--mode", "--workers", "--providers", "--provider-for"].includes(argv[i - 1] ?? ""),
    )
    .join(" ")
    .trim();
  if (request === "") {
    console.error(
      'Say what to do: grafeno-agent run "build the orders API with tests" [--mode controlled] [--workers 3] [--light] [--yes]',
    );
    return 2;
  }
  const settings = runSettings(argv);
  const orchestrator = await createOrchestrator(settings, {
    ...printChanges(),
    ask: async (question) =>
      confirm(
        `\n  ? ${question.worker ?? "The run"} wants to ${question.action} (${question.reason}). Allow it?`,
      ),
  });
  console.log("Planning…");
  const planned = await orchestrator.plan(request);
  for (const line of describePlan(planned)) console.log(line);
  if (!argv.includes("--yes") && !(await confirm("\nRun this plan?"))) {
    console.log("Not run.");
    orchestrator.close();
    return 0;
  }
  const { run, uncommitted } = await orchestrator.start(request, planned);
  if (uncommitted.length > 0) {
    console.log(
      `\nNote: ${String(uncommitted.length)} changed files are not committed; the run starts from your last commit and does not see them.`,
    );
  }
  console.log(
    `\nRun ${run.id} (${settings.mode ?? "controlled"}, up to ${String(settings.workers ?? 3)} workers):`,
  );
  return drive(orchestrator, run.id);
}

async function runsCommand(argv: readonly string[]): Promise<number> {
  const orchestrator = await createOrchestrator({});
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (id) {
    for (const line of describeReport(orchestrator.report(id))) console.log(line);
  } else {
    const runs = orchestrator.runs();
    if (runs.length === 0) console.log("No runs in this project yet.");
    for (const run of runs) {
      console.log(
        `${run.id}  ${run.state.padEnd(10)} ${run.created.slice(0, 16).replace("T", " ")}  ${run.request.slice(0, 60)}`,
      );
    }
  }
  orchestrator.close();
  return 0;
}

async function resumeCommand(argv: readonly string[]): Promise<number> {
  if (argv.includes("--compact")) return compactResumeCommand(argv);
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("Which run? grafeno-agent runs lists them.");
    return 2;
  }
  const orchestrator = await createOrchestrator(runSettings(argv), {
    ...printChanges(),
    ask: async (question) =>
      confirm(
        `\n  ? ${question.worker ?? "The run"} wants to ${question.action} (${question.reason}). Allow it?`,
      ),
  });
  console.log(`Resuming ${id}:`);
  return drive(orchestrator, id);
}

/**
 * Prints the compact resume. It never fails a session it starts: when memory
 * cannot be reached, the text says so and the exit code is still 0.
 */
async function compactResumeCommand(argv: readonly string[]): Promise<number> {
  const number = (name: string) => {
    const value = flag(argv, name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(
      `## Where the work stands\nGrafeno Agent is not set up (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}): no checkpoint was loaded.`,
    );
    return 0;
  }
  const task = flag(argv, "--task");
  const project = flag(argv, "--project");
  const agent = flag(argv, "--agent");
  const checkpointBudget = number("--budget");
  const memoryBudget = number("--memory-budget");
  const level = number("--level");
  const query = flag(argv, "--query");
  // Level 0: the checkpoint alone, no memories looked up.
  const maxMemories = level === 0 ? 0 : number("--max-memories");
  const resumed = await resumeCompact(config, {
    ...(task === undefined ? {} : { task }),
    ...(project === undefined ? {} : { project }),
    ...(agent === undefined ? {} : { agent }),
    ...(checkpointBudget === undefined ? {} : { checkpointBudget }),
    ...(memoryBudget === undefined ? {} : { memoryBudget }),
    ...(maxMemories === undefined ? {} : { maxMemories }),
    ...(query === undefined ? {} : { query }),
  });
  if (argv.includes("--json")) console.log(JSON.stringify(resumed, null, 2));
  else console.log(resumed.text);
  console.error(describeResumeStats(resumed));
  return 0;
}

/** What the router learned so far, from the metrics of every project. */
async function routerCommand(argv: readonly string[]): Promise<number> {
  const { dataDir } = await import("./orchestrator/orchestrator.js");
  const { importRuns, MetricsStore } = await import("./orchestrator/metrics.js");
  const { computeStats, describeStats } = await import("./orchestrator/stats.js");
  const { join } = await import("node:path");
  const metrics = new MetricsStore(join(dataDir(), "metrics.db"));
  try {
    if (argv.includes("--import")) {
      console.log(`Imported ${String(importRuns(dataDir(), metrics))} runs.\n`);
    }
    const attempts = metrics.attempts();
    for (const line of describeStats(computeStats(attempts, metrics.outcomes()), attempts.length)) {
      console.log(line);
    }
  } finally {
    metrics.close();
  }
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  // Real environment variables win over the settings file. Run from the
  // source (development), ./.env is read too; installed, never.
  loadSettings({ fromSource: import.meta.url.endsWith(".ts") });

  const command = argv[0] ?? "chat";
  switch (command) {
    case "chat":
      return chat(argv.includes("--plain"));
    case "check":
      return check();
    case "init":
      return init(argv.slice(1));
    case "version":
    case "--version":
    case "-v":
      console.log(version());
      return 0;
    case "upkeep":
      return runUpkeep(argv.includes("--apply"));
    case "run":
      return orchestrateCommand(argv.slice(1));
    case "runs":
      return runsCommand(argv.slice(1));
    case "resume":
      return resumeCommand(argv.slice(1));
    case "router":
      return routerCommand(argv.slice(1));
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(
        `${error.message}\n\nSettings file: ${settingsPath()} (grafeno-agent init writes one to fill in).`,
      );
    } else if (error instanceof StartupError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  },
);
