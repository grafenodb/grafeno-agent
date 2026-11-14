#!/usr/bin/env node
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
          arrangement. Add --apply to carry out the safe fixes.`;

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
