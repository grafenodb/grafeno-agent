import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** What runs the Skills CLI: a program and its first arguments. */
export interface SkillsCommand {
  readonly command: string;
  readonly prefix: readonly string[];
}

/**
 * The official Skills CLI (`npx skills`, by Vercel Labs), run through the
 * npm that comes with this Node: its `npx-cli.js` with Node itself, so no
 * shell parses the arguments. Without it, `npx` on the PATH.
 */
export function skillsCommand(execPath = process.execPath): SkillsCommand {
  const candidates = [
    join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  const cli = candidates.find((path) => existsSync(path));
  return cli
    ? { command: execPath, prefix: [cli, "--yes", "skills"] }
    : { command: "npx", prefix: ["--yes", "skills"] };
}

/** A source or skill name the CLI is given: no spaces or shell characters. */
export function safeArgument(value: string): boolean {
  return /^[\w@./:#~+-]+$/.test(value);
}

/** The Skills CLI's arguments for what the agent offers: always for the `universal` agent. */
export function skillsArguments(
  action:
    | { readonly kind: "add"; readonly source: string; readonly skills?: readonly string[] }
    | { readonly kind: "remove"; readonly name: string }
    | { readonly kind: "find"; readonly query?: string }
    | { readonly kind: "update" },
  global: boolean,
): string[] {
  const scope = global ? ["-g"] : [];
  switch (action.kind) {
    case "add":
      return [
        "add",
        action.source,
        "-a",
        "universal",
        "-y",
        ...scope,
        ...(action.skills ?? []).flatMap((s) => ["--skill", s]),
      ];
    case "remove":
      return ["remove", action.name, "-a", "universal", "-y", ...scope];
    case "find":
      return ["find", ...(action.query ? [action.query] : [])];
    case "update":
      return ["update", "-y", ...scope];
  }
}

/**
 * Runs the Skills CLI in a folder (the project, so that a project install
 * lands in its .agents/skills), its output shown as it comes; resolves with
 * its exit code.
 */
export function runSkills(
  args: readonly string[],
  cwd: string,
  command: SkillsCommand = skillsCommand(),
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command.command, [...command.prefix, ...args], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", () => {
      resolve(127);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
