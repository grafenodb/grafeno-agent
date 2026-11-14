/** A slash command of the interface. */
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

export const COMMANDS: readonly Command[] = [
  { name: "help", description: "Commands and keys" },
  { name: "new", description: "Start a new conversation (the current one is kept)" },
  { name: "resume", description: "Take up an earlier conversation of this project" },
  { name: "models", description: "Choose the model", aliases: ["model"] },
  { name: "effort", description: "Choose how hard the model thinks" },
  { name: "connect", description: "Connect a provider (Claude today)" },
  { name: "palace", description: "Grafeno: included, or a server you already have" },
  { name: "usage", description: "Your provider's real usage, and this session's" },
  { name: "status", description: "Provider, Grafeno, agent, project and model" },
  { name: "memory", description: "What memory brought back when the session started" },
  { name: "checkpoint", description: "Save where the work stands, in memory" },
  { name: "upkeep", description: "Report on the memory: duplicates, contradictions" },
  { name: "sidebar", description: "Show or hide the side panel (ctrl+b)" },
  { name: "clear", description: "Clear the conversation from the screen" },
  { name: "exit", description: "Leave, saving where the session stands", aliases: ["quit"] },
];

/** The command a line asks for: `/models` → models; undefined for a message. */
export function parseCommand(line: string): { name: string; known: boolean } | undefined {
  const match = /^\/(\S+)\s*$/.exec(line.trim());
  if (!match) return undefined;
  const word = (match[1] ?? "").toLowerCase();
  const command = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  return { name: command?.name ?? word, known: command !== undefined };
}

/** The commands that start with what was typed after the slash. */
export function suggest(line: string): Command[] {
  const match = /^\/(\S*)$/.exec(line);
  if (!match) return [];
  const prefix = (match[1] ?? "").toLowerCase();
  return COMMANDS.filter(
    (c) => c.name.startsWith(prefix) || c.aliases?.some((a) => a.startsWith(prefix)),
  );
}
