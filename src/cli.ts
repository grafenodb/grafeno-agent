#!/usr/bin/env node
import { TASK_KINDS } from "./orchestrator/plan.js";
import {
  isAuto,
  KNOWN_PROVIDERS,
  PROVIDER_SECRET_ENV,
  providerForKinds,
  providerIds,
} from "./providers/index.js";
import type { Provider } from "./providers/types.js";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { SYSTEM_PROMPT } from "./agent/builtin-tools.js";
import { ToolRegistry } from "./agent/tools.js";
import { detectLanguage, withLanguage } from "./agent/language.js";
import {
  decide,
  isPermissionMode,
  PERMISSION_MODES,
  settingsPermissionMode,
  type PermissionMode,
} from "./agent/permissions.js";
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
import { AUTONOMY, type Autonomy, type Question } from "./orchestrator/policy.js";
import { describeReport } from "./orchestrator/telemetry.js";
import { describeResumeStats, resumeCompact } from "./app/resume.js";
import { describeReplan } from "./orchestrator/replan.js";
import { describeDelivery } from "./orchestrator/deliver.js";

const USAGE = `Usage: grafeno-agent <command>

Run it in the project you want help with.

Commands:
  chat     Talk with the agent (the default). In a terminal it opens the full
           interface; --plain (or piped input) talks line by line.
  init     Set up: --include-grafeno (Grafeno runs on this computer), or
           --grafeno-url <url> --key <key> (a Grafeno server you have).
  check    Check the settings, that Grafeno answers and that the agent's key works.
  mcp [add|remove]
                 External MCP servers (mcp.json next to the settings): their tools reach
                 the agent, asking you before they change anything. A server is checked
                 when it is added. grafeno-agent mcp help says more.
  plugins [enable|disable] <id>
                 Services the agent works with, as you: github, gitlab. Off until you turn
                 one on; each is checked first, with the service's own documented sign-in
                 (the official gh / glab CLI's, or a token you made). Reading runs at once,
                 anything that changes something asks you first.
  skills [add|find|remove|update|new|check]
                 The skills the agent uses (.agents/skills, ~/.agents/skills,
                 ~/.config/agents/skills): install with the Skills CLI (npx skills),
                 or write your own. grafeno-agent skills help says more.
  login gemini | login openrouter
                 A provider reached with your own API key: the key is checked with the
                 provider before it is kept, in the system's secure store (never in
                 Grafeno). Gemini: its tier (free or paid). OpenRouter: free models only
                 (the default) or paid ones. Either may join Auto only if you say so.
                 logout <provider> removes it. Claude and Codex sign in with their own programs.
  version  Show the version.
  upkeep  Look after the project's memory: duplicates, contradictions, the palace's
          arrangement. Add --apply to carry out the safe fixes.
  run "<request>"  Plan the request and run it with several workers, each in its own
          git worktree; the work lands on an integration branch for you to merge.
          --mode supervised|controlled|extended (default controlled), --workers N
          (default 3), --light (light models, low effort), --yes (no confirmation),
          --providers claude-code,codex, or --providers auto (default AGENT_PROVIDERS, auto)
          (General Auto: every ready provider as one pool, each task kind to its
          affinity, AGENT_AFFINITY), --provider-for tests=codex,docs=codex (which
          provider takes a kind of task). Limits for the whole run: --max-tokens N
          (reported input + output), --max-work M (minutes of work), --max-retries N
          (failed attempts); reaching one pauses the run, saying which. --review: after
          a task's checks pass, a reviewer on another model reads its change and may
          send it back with issues (twice at most); it never approves, and a
          disagreement left over goes to a person. --permissions ask|auto|skip: how
          the workers' calls that would ask are decided (default AGENT_PERMISSIONS, ask).
          --unattended: nobody watches: the plan runs without asking, permissions are
          skipped, the run goes on in extended mode (replans, retries, merges when its
          checks pass) until it ends. What is never allowed stays so.
  runs [id]  The project's runs, or one run's report.
  resume <id>  Go on with a paused or waiting run (the same limit flags, higher, let a
          run paused by one go on).
  run "<request>" --background  Plan it here, then a detached process runs it: this terminal
          may close. A desktop notification says when it ends or needs a person.
  pause <id> | cancel <id>  Ask the process running a run (here or in the background) to
          pause (finish what runs) or cancel it. After a reboot, an interrupted background
          run is resumed when grafeno-agent next starts.
  replan <id> [--yes]  New tasks in place of what failed in a run, and what depends on it,
          from the planner, checked by code; completed work is kept. Shown first;
          then the run goes on. In --mode extended a run replans on its own (at most
          twice).
  resume --compact  Print where the project's work stands, compact, for a new session:
          the latest checkpoint and a few related memories, within budgets. Only reads
          memory, calls no model. --task <name> (a task's checkpoints instead of the
          project's), --project <name>, --budget N (checkpoint tokens, default 500),
          --memory-budget N (default 500), --max-memories N (default 5), --json.
          --level 0 (the checkpoint alone), 1 (and related memories: the default),
          2 --query "<topic>" (memories about something specific). Measures go to
          stderr. Meant for a Claude Code SessionStart hook.
  router [--import] [--compare]  What the router has learned: each kind of task and complexity, each
          provider, model and effort, how often it succeeded cleanly (with its 95%
          interval), cost and time, and whether the sample is big enough to count.
          --import first reads the runs already kept for every project. --compare
          replays the recorded tasks in order and says where the learned router would
          have chosen differently from what ran, with estimated savings and risk.`;

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
  const ownTools = projectTools(workspace, {
    hiddenEnv: ["GRAFENO_AGENT_KEY", ...PROVIDER_SECRET_ENV],
  });
  const system = `${memory.systemPrompt(SYSTEM_PROMPT)}\n\n${toolsPrompt(workspace)}`;
  let language: string | undefined;
  await runChat({
    input: process.stdin,
    output: process.stdout,
    endOfSession: memory.endOfSession(),
    makeAgent: (approve) =>
      new Agent({
        model,
        system,
        // AGENT_PERMISSIONS decides first; what it leaves to the user is asked here.
        tools: new ToolRegistry(
          [...ownTools, ...memoryTools],
          async (call, tool, decision) => {
            const decided = decide(settingsPermissionMode(), tool, call.input, decision);
            if (decided.verdict !== "ask") return decided.verdict === "allow";
            return approve(call, tool, { ...decision, reason: decided.reason });
          },
          {
            redact: [config.agentKey],
          },
        ),
        prepare: async (message) => {
          if (message !== memory.endOfSession()) language = detectLanguage(message) ?? language;
          return withLanguage(await memory.beforeTurn(message), message, language);
        },
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
  const positive = (name: string, scale = 1): number | undefined => {
    const raw = flag(argv, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} takes a number above 0`);
    return Math.round(value * scale);
  };
  const tokens = positive("--max-tokens");
  const workMs = positive("--max-work", 60_000);
  const retries = positive("--max-retries");
  const limits = {
    ...(tokens === undefined ? {} : { tokens }),
    ...(workMs === undefined ? {} : { workMs }),
    ...(retries === undefined ? {} : { retries }),
  };
  return {
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(argv.includes("--review") ? { review: true } : {}),
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
async function drive(
  orchestrator: Orchestrator,
  runId: string,
  yes = false,
  background = false,
): Promise<number> {
  // A task that fails for good is replanned (phase D3): on its own in the
  // extended mode, else after asking (or with --yes). In the background
  // there is no one to ask: only the extended mode replans.
  const state = await orchestrator.runWithReplans(
    runId,
    async (proposal) => {
      if (background) return false;
      console.log("");
      for (const line of describeReplan(proposal)) console.log(line);
      return yes || (await confirm("\nReplan what failed this way?"));
    },
    (proposal) => {
      console.log(`\nReplanned: ${proposal.replaced.join(", ")} replaced. Going on.`);
    },
  );
  console.log("");
  for (const line of describeReport(orchestrator.report(runId))) console.log(line);
  const delivery = state === "completed" ? orchestrator.delivery(runId) : undefined;
  if (delivery) {
    // Phase D6 (extended): the work went, or tried to go, into the user's branch.
    for (const line of describeDelivery(delivery, orchestrator.integrationBranch(runId)))
      console.log(line);
  }
  if (state === "completed" && (!delivery || !["merged", "already"].includes(delivery.status))) {
    const branch = orchestrator.integrationBranch(runId);
    console.log(
      `\nThe work is on the branch ${branch}. Look at it, then merge it when you are ready:`,
    );
    console.log(`  git diff HEAD...${branch}`);
    console.log(`  git merge ${branch}`);
  } else if (state === "paused" || state === "waiting") {
    console.log(`\nThe run is ${state}. Go on with: grafeno-agent resume ${runId}`);
  } else if (state === "failed") {
    console.log(`\nThe run failed. Replan what failed with: grafeno-agent replan ${runId}`);
  }
  if (background) {
    // Phase D4: a background run tells the person when it ends or needs them.
    const { notify } = await import("./orchestrator/supervisor.js");
    const needs =
      state === "waiting"
        ? "it needs a person"
        : state === "paused"
          ? "it is paused"
          : state === "failed"
            ? "it failed"
            : state;
    await notify("Grafeno Agent", `Run ${runId}: ${needs}. grafeno-agent runs ${runId}`);
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
        ![
          "--mode",
          "--permissions",
          "--workers",
          "--providers",
          "--provider-for",
          "--max-tokens",
          "--max-work",
          "--max-retries",
        ].includes(argv[i - 1] ?? ""),
    )
    .join(" ")
    .trim();
  if (request === "") {
    console.error(
      'Say what to do: grafeno-agent run "build the orders API with tests" [--mode controlled] [--workers 3] [--light] [--yes]',
    );
    return 2;
  }
  // Unattended: nobody watches; the plan runs, permissions are skipped, the run goes on alone.
  const unattended = argv.includes("--unattended");
  const asked = flag(argv, "--permissions");
  if (asked !== undefined && !isPermissionMode(asked)) {
    console.error(`--permissions is one of ${PERMISSION_MODES.join(", ")}: ${asked}`);
    return 2;
  }
  const permissions: PermissionMode = unattended
    ? "skip"
    : asked !== undefined && isPermissionMode(asked)
      ? asked
      : settingsPermissionMode();
  const settings = {
    ...runSettings(argv),
    ...(unattended && flag(argv, "--mode") === undefined ? { mode: "extended" as const } : {}),
  };
  if (unattended) {
    console.log(
      "Unattended: the plan runs without asking, workers' calls run without asking (what is never allowed stays so), and the run merges when its checks pass.",
    );
  }
  const orchestrator = await createOrchestrator(settings, {
    ...printChanges(),
    onDelivered: ({ lines }) => {
      for (const line of lines) console.log(`  ${line.trim()}`);
    },
    onNote: (note) => {
      if (note.kind === "progress") {
        console.log(`  ${note.task} → orchestrator: ${note.report.summary}`);
      } else {
        const { request, decision } = note;
        console.log(
          `  ${request.from} asks for ${request.kind === "rerun" ? `a rerun of ${request.task ?? request.from}` : "a new task"}: ${decision.accept ? `accepted as ${decision.added?.id ?? "?"}` : "rejected"} (${decision.reason})`,
        );
      }
    },
    permissions,
    ask: async (question) =>
      unattended ||
      confirm(
        `\n  ? ${question.worker ?? "The run"} wants to ${question.action} (${question.reason}). Allow it?`,
      ),
  });
  console.log("Planning…");
  const planned = await orchestrator.plan(request);
  for (const line of describePlan(planned)) console.log(line);
  if (!argv.includes("--yes") && !unattended && !(await confirm("\nRun this plan?"))) {
    console.log("Not run.");
    orchestrator.close();
    return 0;
  }
  const { run, uncommitted } = await orchestrator.start(request, planned);
  console.log(orchestrator.describeWork(run.id));
  if (argv.includes("--background")) {
    // Phase D4: a detached process owns the run; this terminal may close.
    orchestrator.close();
    const { startBackground } = await import("./orchestrator/supervisor.js");
    const { dataDir } = await import("./orchestrator/orchestrator.js");
    const { log } = startBackground(run.id, {
      cwd: process.cwd(),
      dataDir: dataDir(),
      args: settingsArgs(argv),
    });
    console.log(`\nRunning ${run.id} in the background. Its log: ${log}`);
    console.log(
      `  grafeno-agent runs ${run.id}    how it goes\n  grafeno-agent pause ${run.id}   finish what runs, start nothing new\n  grafeno-agent cancel ${run.id}  stop it\n  grafeno-agent resume ${run.id}  go on (add --background to keep it in the background)`,
    );
    return 0;
  }
  if (uncommitted.length > 0) {
    console.log(
      `\nNote: ${String(uncommitted.length)} changed files are not committed; the run starts from your last commit and does not see them.`,
    );
  }
  console.log(
    `\nRun ${run.id} (${settings.mode ?? "controlled"}, up to ${String(settings.workers ?? 3)} workers):`,
  );
  return drive(orchestrator, run.id, argv.includes("--yes"));
}

async function runsCommand(argv: readonly string[]): Promise<number> {
  const orchestrator = await createOrchestrator({});
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (id) {
    for (const line of describeReport(orchestrator.report(id))) console.log(line);
  } else {
    const runs = orchestrator.runs();
    if (runs.length === 0) console.log("No runs in this project yet.");
    const { liveness } = await import("./orchestrator/supervisor.js");
    for (const run of runs) {
      // Phase D4: whether a process works on it now, or it was interrupted.
      const live = liveness(orchestrator.store, run.id);
      const who =
        live.liveness === "running"
          ? `live (pid ${String(live.supervisor?.pid ?? "?")}${live.supervisor?.background ? ", background" : ""})`
          : live.liveness === "interrupted"
            ? "interrupted: grafeno-agent resume to go on"
            : "";
      console.log(
        `${run.id}  ${run.state.padEnd(10)} ${run.created.slice(0, 16).replace("T", " ")}  ${run.request.slice(0, 60)}${who ? `  [${who}]` : ""}`,
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
  const background = argv.includes("--owner=background");
  if (argv.includes("--background")) {
    const { startBackground } = await import("./orchestrator/supervisor.js");
    const { dataDir } = await import("./orchestrator/orchestrator.js");
    const { log } = startBackground(id, {
      cwd: process.cwd(),
      dataDir: dataDir(),
      args: settingsArgs(argv),
    });
    console.log(`Resuming ${id} in the background. Its log: ${log}`);
    return 0;
  }
  const orchestrator = await createOrchestrator(runSettings(argv), {
    ...printChanges(),
    // In the background there is no one at a terminal: what needs a person waits for review.
    ...(background
      ? {
          owner: {
            background: true,
            cwd: process.cwd(),
            args: settingsArgs(argv),
          },
        }
      : {
          ask: async (question: Question) =>
            confirm(
              `\n  ? ${question.worker ?? "The run"} wants to ${question.action} (${question.reason}). Allow it?`,
            ),
        }),
  });
  console.log(`Resuming ${id}${background ? " in the background" : ""}:`);
  return drive(orchestrator, id, argv.includes("--yes"), background);
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
    const outcomes = metrics.outcomes();
    for (const line of describeStats(computeStats(attempts, outcomes), attempts.length)) {
      console.log(line);
    }
    if (argv.includes("--compare")) {
      const { compareFixedLearned, describeComparison } = await import("./orchestrator/compare.js");
      console.log("");
      for (const line of describeComparison(compareFixedLearned(attempts, outcomes))) {
        console.log(line);
      }
    }
  } finally {
    metrics.close();
  }
  return 0;
}

/** The run settings on a command line, to give a background process the same ones. */
function settingsArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  const valued = [
    "--mode",
    "--workers",
    "--providers",
    "--provider-for",
    "--max-tokens",
    "--max-work",
    "--max-retries",
  ];
  for (const [i, arg] of argv.entries()) {
    if (valued.includes(arg) && argv[i + 1] !== undefined) out.push(arg, argv[i + 1] ?? "");
    if (arg === "--light" || arg === "--review") out.push(arg);
  }
  return out;
}

/** Sends a run's owner an order (phase D4): pause or cancel, from any terminal. */
async function controlCommand(
  control: "pause" | "cancel",
  argv: readonly string[],
): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("Which run? grafeno-agent runs lists them.");
    return 2;
  }
  const { dataDir, runStoreFile } = await import("./orchestrator/orchestrator.js");
  const { SqliteStore } = await import("./orchestrator/store.js");
  const { liveness } = await import("./orchestrator/supervisor.js");
  const project = detectProject(process.cwd(), process.env.AGENT_PROJECT);
  const store = new SqliteStore(runStoreFile(dataDir(), project.name));
  try {
    const run = store.run(id);
    if (!run) {
      console.error(`No run ${id} in ${project.name}. grafeno-agent runs lists them.`);
      return 1;
    }
    const live = liveness(store, id);
    if (live.liveness !== "running") {
      if (control === "cancel" && run.state !== "completed" && run.state !== "cancelled") {
        for (const task of store.tasks(id)) {
          if (task.state !== "completed" && task.state !== "cancelled") {
            store.transition(id, task.id, "cancelled", { reason: "the run was cancelled" });
          }
        }
        store.setRunState(id, "cancelled");
        console.log(`${id} is cancelled (no process was running it).`);
        return 0;
      }
      console.log(`No process runs ${id} now (${run.state}): there is nothing to ${control}.`);
      return 0;
    }
    store.requestControl(id, control);
    console.log(
      control === "pause"
        ? `Asked ${id} to pause: what runs finishes, nothing new starts.`
        : `Asked ${id} to cancel: what runs is stopped.`,
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Phase D4: background runs interrupted by a reboot (or a crash) are resumed
 * the same way, in their own folder, when Grafeno Agent next starts.
 */
async function resumeInterrupted(): Promise<void> {
  const { dataDir } = await import("./orchestrator/orchestrator.js");
  const { interruptedRuns, startBackground } = await import("./orchestrator/supervisor.js");
  const { SqliteStore } = await import("./orchestrator/store.js");
  for (const run of interruptedRuns(dataDir())) {
    if (!run.supervisor.cwd) continue;
    const { log, pid } = startBackground(run.runId, {
      cwd: run.supervisor.cwd,
      dataDir: dataDir(),
      ...(run.supervisor.args ? { args: run.supervisor.args } : {}),
    });
    // Seen as live at once, so another start does not resume it twice.
    const store = new SqliteStore(run.file);
    try {
      store.supervise(run.runId, { pid, background: true });
    } finally {
      store.close();
    }
    console.error(`Resumed ${run.runId} in the background: its process had stopped. Log: ${log}`);
  }
}

/** Replans what failed in a run (phase D3), after showing it, then goes on with the run. */
async function replanCommand(argv: readonly string[]): Promise<number> {
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
  console.log(`Replanning what failed in ${id}…`);
  let proposal;
  try {
    proposal = await orchestrator.proposeReplan(id);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    orchestrator.close();
    return 1;
  }
  for (const line of describeReplan(proposal)) console.log(line);
  if (!argv.includes("--yes") && !(await confirm("\nReplan what failed this way?"))) {
    orchestrator.close();
    return 1;
  }
  orchestrator.applyReplan(proposal);
  return drive(orchestrator, id, argv.includes("--yes"));
}

/** `login gemini|openrouter` / `logout …`: a provider's key, checked, kept in the system's secure store. */
async function loginCommand(command: "login" | "logout", args: readonly string[]): Promise<number> {
  const which = args[0];
  if (which !== "gemini" && which !== "openrouter") {
    console.error(
      "Providers with an API key sign in here: login gemini, login openrouter. Claude and Codex sign in with their own programs (claude /login, codex login).",
    );
    return 2;
  }
  const { geminiLogin, geminiLogout, openRouterLogin, openRouterLogout } =
    await import("./app/login.js");
  const { geminiStore } = await import("./providers/gemini.js");
  const { autoMembers } = await import("./providers/index.js");
  const { updateSettings } = await import("./settings-file.js");
  const io = {
    ask: (question: string, options: { hidden?: boolean } = {}) => askLine(question, options),
    say: (line: string) => {
      console.log(line);
    },
  };
  const options = {
    io,
    // The same secure store for every key (DPAPI, Secret Service, Keychain).
    store: geminiStore(),
    saveSettings: (v: Record<string, string>) => {
      updateSettings(v);
    },
    autoMembers: autoMembers(),
  };
  if (which === "openrouter") {
    return command === "login" ? openRouterLogin(options) : openRouterLogout(options);
  }
  return command === "login" ? geminiLogin(options) : geminiLogout(options);
}

/** Reads a line from the terminal; `hidden`: what is typed is not echoed. */
async function askLine(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("This needs a terminal.");
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (options.hidden) {
    // Echo nothing of what is typed (a key), only the question.
    const output = lines as unknown as { _writeToOutput?: (text: string) => void };
    output._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(question);
    };
  }
  try {
    return await lines.question(question);
  } finally {
    if (options.hidden) process.stdout.write("\n");
    lines.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  // Real environment variables win over the settings file. Run from the
  // source (development), ./.env is read too; installed, never.
  loadSettings({ fromSource: import.meta.url.endsWith(".ts") });

  const command = argv[0] ?? "chat";
  // Phase D4: interrupted background runs go on (not from a background process itself).
  if (
    !argv.includes("--owner=background") &&
    !["help", "--help", "-h", "version", "--version", "-v"].includes(command)
  ) {
    await resumeInterrupted().catch(() => undefined);
  }
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
    case "replan":
      return replanCommand(argv.slice(1));
    case "pause":
      return controlCommand("pause", argv.slice(1));
    case "cancel":
      return controlCommand("cancel", argv.slice(1));
    case "mcp": {
      const { mcpCommand } = await import("./app/mcp-command.js");
      return mcpCommand(argv.slice(1), {
        say: (line) => {
          console.log(line);
        },
      });
    }
    case "plugins": {
      const { pluginsCommand } = await import("./app/plugins-command.js");
      return pluginsCommand(argv.slice(1), {
        say: (line) => {
          console.log(line);
        },
      });
    }
    case "skills": {
      const { skillsCommand } = await import("./app/skills-command.js");
      return skillsCommand(argv.slice(1), {
        cwd: process.cwd(),
        say: (line) => {
          console.log(line);
        },
      });
    }
    case "login":
    case "logout":
      return loginCommand(command, argv.slice(1));
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
