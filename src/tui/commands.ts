/** A slash command of the interface. */
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

export const COMMANDS: readonly Command[] = [
  { name: "help", description: "Commands and keys" },
  { name: "new", description: "Start a new conversation (the current one is kept)" },
  {
    name: "resume",
    description: "Take up an earlier conversation of this project, or delete one",
    aliases: ["sessions"],
  },
  {
    name: "projects",
    description: "Your projects: open one (a session in its folder), add this folder, or make one",
  },
  { name: "models", description: "Choose the model", aliases: ["model"] },
  {
    name: "sandbox",
    description: "Grafeno Sandbox: status, list, create, inspect, stop, destroy, cleanup",
  },
  {
    name: "leader",
    description: "Choose the leader of orchestrated runs: it plans, assigns and audits the tasks",
  },
  { name: "effort", description: "Choose how hard the model thinks" },
  { name: "connect", description: "Choose the provider the chat uses (Claude, Codex…)" },
  { name: "mode", description: "Auto, or the provider chosen in /connect (auto, specific)" },
  { name: "palace", description: "Grafeno: included, or a server you already have" },
  {
    name: "permissions",
    description:
      "Ask, automatic or skip permissions: for the agent, this session, or with its sub-agents",
  },
  {
    name: "unattended",
    description: "Work on alone until the task is done: no questions, plans run, sub-agents too",
  },
  {
    name: "usage",
    description:
      "Your provider's real usage (a reading of the last minute; /usage refresh asks anew), and this session's",
  },
  { name: "status", description: "Provider, Grafeno, agent, project and model" },
  { name: "memory", description: "What memory brought back when the session started" },
  { name: "checkpoint", description: "Save where the work stands, in memory" },
  { name: "orchestrate", description: "Plan a request and run it with several workers" },
  { name: "runs", description: "Earlier runs of this project: see or resume one" },
  {
    name: "agents",
    description: "The main agent and its sub-agents: view one (read only; ctrl+n next)",
  },
  {
    name: "skills",
    description: "The skills the agent can use (install: grafeno-agent skills add)",
  },
  {
    name: "mcp",
    description: "MCP servers: Grafeno's own (always on) and yours (add: grafeno-agent mcp add)",
  },
  {
    name: "plugins",
    description: "Services the agent works with: GitHub, GitLab (on: grafeno-agent plugins enable)",
  },
  { name: "upkeep", description: "Report on the memory: duplicates, contradictions" },
  { name: "sidebar", description: "Show or hide the side panel (ctrl+b)" },
  { name: "clear", description: "Clear the conversation from the screen" },
  { name: "exit", description: "Leave, saving where the session stands", aliases: ["quit"] },
];

/** The command a line asks for: `/models` → models, `/orchestrate build x` → orchestrate with "build x"; undefined for a message. */
export function parseCommand(
  line: string,
): { name: string; known: boolean; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match) return undefined;
  const word = (match[1] ?? "").toLowerCase();
  const command = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  return {
    name: command?.name ?? word,
    known: command !== undefined,
    args: (match[2] ?? "").trim(),
  };
}

/** The commands that start with what was typed after the slash. */
export function suggest(line: string): Command[] {
  const match = /^\/(\S*)$/.exec(line);
  if (!match) return [];
  const prefix = (match[1] ?? "").toLowerCase();
  const found = COMMANDS.filter(
    (c) => c.name.startsWith(prefix) || c.aliases?.some((a) => a.startsWith(prefix)),
  );
  // A command typed whole comes first: "/mode" is /mode, not /models (whose alias starts so).
  const exact = (c: Command) => c.name === prefix || c.aliases?.includes(prefix) === true;
  return [...found.filter(exact), ...found.filter((c) => !exact(c))];
}
