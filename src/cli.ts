#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { SYSTEM_PROMPT, currentTimeTool } from "./agent/builtin-tools.js";
import { ToolRegistry } from "./agent/tools.js";
import { runChat } from "./chat.js";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { MemorySession } from "./memory/session.js";
import { detectProject } from "./memory/project.js";
import { describeUpkeep, upkeep } from "./memory/upkeep.js";
import { grafenoVault } from "./memory/vault.js";
import { createModel } from "./model/index.js";
import { StartupError, checkGrafeno } from "./startup.js";

const USAGE = `Usage: grafeno-agent <command>

Commands:
  chat    Talk with the agent (the default).
  check   Check the settings, that Grafeno answers and that the agent's key works.
  upkeep  Look after the project's memory: duplicates, contradictions, the palace's
          arrangement. Add --apply to carry out the safe fixes.`;

/** Days between upkeeps before the chat suggests one. */
const UPKEEP_EVERY_DAYS = 7;

async function check(): Promise<number> {
  const config = loadConfig();
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
  const memory = await MemorySession.start({
    vault: grafenoVault(config),
    project,
    knownSecrets: [config.agentKey],
  });
  const memoryTools = await memory.tools();
  const last = await memory.lastUpkeep();
  if (!last || Date.now() - last.getTime() > UPKEEP_EVERY_DAYS * 86_400_000) {
    const when = last ? `last ran ${last.toISOString().slice(0, 10)}` : "has not run yet";
    console.log(`Memory upkeep ${when}: run \`npm run upkeep\`.`);
  }
  console.log(
    `Project: ${project.name} (memory: palace "${project.name}" in namespace "${config.namespace}")`,
  );

  const model = createModel(config.model, {
    ...(config.claudeModel === undefined ? {} : { claudeModel: config.claudeModel }),
  });
  await runChat({
    input: process.stdin,
    output: process.stdout,
    endOfSession: memory.endOfSession(),
    makeAgent: (approve) =>
      new Agent({
        model,
        system: memory.systemPrompt(SYSTEM_PROMPT),
        tools: new ToolRegistry([currentTimeTool(), ...memoryTools], approve),
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
  // Settings from `.env` when present; real environment variables win.
  if (existsSync(".env")) process.loadEnvFile(".env");

  const command = argv[0] ?? "chat";
  switch (command) {
    case "chat":
      return chat();
    case "check":
      return check();
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
    if (error instanceof ConfigError || error instanceof StartupError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  },
);
