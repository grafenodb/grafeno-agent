#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent/agent.js";
import { SYSTEM_PROMPT } from "./agent/builtin-tools.js";
import { ToolRegistry } from "./agent/tools.js";
import { runChat } from "./chat.js";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { LOCAL_MODELS, localEmbedder } from "./embed/local.js";
import type { Embedder } from "./embed/types.js";
import { initSettings, loadSettings, settingsPath } from "./settings-file.js";
import { projectTools, toolsPrompt } from "./tools/index.js";
import { Workspace } from "./tools/workspace.js";
import { MemorySession } from "./memory/session.js";
import { detectProject } from "./memory/project.js";
import { describeUpkeep, upkeep } from "./memory/upkeep.js";
import { grafenoVault } from "./memory/vault.js";
import { createModel } from "./model/index.js";
import { StartupError, checkGrafeno } from "./startup.js";

const USAGE = `Usage: grafeno-agent <command>

Run it in the project you want help with.

Commands:
  chat     Talk with the agent (the default).
  init     Write the settings file to fill in (it never overwrites one).
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

function init(): number {
  const path = settingsPath();
  if (!initSettings(path)) {
    console.log(`The settings file is already there: ${path}`);
    return 0;
  }
  console.log(`Wrote ${path}\n`);
  console.log(
    "Fill in GRAFENO_AGENT_KEY there. An administrator of your Grafeno server makes the key:",
  );
  console.log(
    "\n  grafeno keys create grafeno-agent --grant grafeno-agent:write --config <grafeno.toml>\n",
  );
  console.log("Then run: grafeno-agent check");
  return 0;
}

/** The embedder the settings name, when it can run here. */
async function embedderFor(name: string): Promise<Embedder | undefined> {
  if (name !== "e5-small") return undefined;
  try {
    await import("@huggingface/transformers");
  } catch {
    console.log(
      "Meaning is off: @huggingface/transformers is not installed, so memory works by words alone.",
    );
    return undefined;
  }
  const model = LOCAL_MODELS["e5-small"].id.split("/");
  if (!existsSync(join(homedir(), ".cache", "grafeno-agent", "models", ...model))) {
    console.log("The meaning model is downloaded once, on first use (about 130 MB).");
  }
  return localEmbedder("e5-small");
}

async function check(): Promise<number> {
  const config = loadConfig();
  const file = settingsPath();
  console.log(`settings:  ${file}${existsSync(file) ? "" : " (not there: grafeno-agent init)"}`);
  console.log(describeConfig(config));
  const report = await checkGrafeno(config);
  console.log(
    `\nGrafeno ${report.serverVersion} answers; the key works in "${report.namespace}" ` +
      `(${String(report.tools.length)} memory tools).`,
  );
  return 0;
}

async function chat(): Promise<number> {
  const config = loadConfig();
  await checkGrafeno(config);
  const project = detectProject(process.cwd(), config.project);
  const embedder = await embedderFor(config.embedder);
  const memory = await MemorySession.start({
    vault: grafenoVault(config),
    project,
    knownSecrets: [config.agentKey],
    ...(embedder ? { embedder } : {}),
  });
  const memoryTools = await memory.tools();
  const last = await memory.lastUpkeep();
  if (!last || Date.now() - last.getTime() > UPKEEP_EVERY_DAYS * 86_400_000) {
    const when = last ? `last ran ${last.toISOString().slice(0, 10)}` : "has not run yet";
    console.log(`Memory upkeep ${when}: run \`grafeno-agent upkeep\`.`);
  }
  console.log(
    `Project: ${project.name} (memory: palace "${project.name}" in namespace "${config.namespace}")`,
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
  await checkGrafeno(config);
  const vault = grafenoVault(config);
  const project = detectProject(process.cwd(), config.project);
  const memory = await MemorySession.start({ vault, project, knownSecrets: [config.agentKey] });
  const report = await upkeep({ vault, palace: project.name, projectId: memory.projectId, apply });
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
      return chat();
    case "check":
      return check();
    case "init":
      return init();
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
