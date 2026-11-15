import { execFile } from "node:child_process";
import { arch, cpus, freemem, platform, release, totalmem, type } from "node:os";
import type { Tool } from "../agent/tools.js";
import type { Workspace } from "./workspace.js";

/** Programs whose version is worth knowing when working on a project. */
const PROGRAMS: readonly (readonly [name: string, args: readonly string[]])[] = [
  ["git", ["--version"]],
  ["node", ["--version"]],
  ["npm", ["--version"]],
  ["pnpm", ["--version"]],
  ["yarn", ["--version"]],
  ["bun", ["--version"]],
  ["deno", ["--version"]],
  ["python", ["--version"]],
  ["python3", ["--version"]],
  ["cargo", ["--version"]],
  ["go", ["version"]],
  ["java", ["-version"]],
  ["dotnet", ["--version"]],
  ["docker", ["--version"]],
  ["gh", ["--version"]],
  ["glab", ["--version"]],
];

/** A program's version line, or nothing when it is not installed. */
export function programVersion(
  name: string,
  args: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      name,
      [...args],
      { cwd, timeout: 5000, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const line = `${stdout}\n${stderr}`.split(/\r?\n/).find((l) => l.trim() !== "");
        resolve(line?.trim());
      },
    );
  });
}

export interface EnvironmentToolOptions {
  /** The shell commands run in. */
  readonly shell: readonly string[];
  /** Finds a program's version; for tests. */
  readonly version?: typeof programVersion;
}

const GB = 1024 ** 3;

/**
 * What the agent is working on: the system, the shell, the project's git
 * state and the development programs installed. It only reads.
 */
export function environmentInfoTool(workspace: Workspace, options: EnvironmentToolOptions): Tool {
  const version = options.version ?? programVersion;
  return {
    name: "environment_info",
    description:
      "Describes the environment: the operating system, the shell commands run in, the project folder and its git branch, and which development programs (git, node, npm, python, cargo, go, java, dotnet, docker, gh, glab...) are installed, with their versions. Use it before running commands that depend on them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    writes: false,
    run: async () => {
      const cwd = workspace.root;
      const [branch, ...found] = await Promise.all([
        version("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
        ...PROGRAMS.map(async ([name, args]) => [name, await version(name, args, cwd)] as const),
      ]);
      const installed = found
        .filter(([, v]) => v !== undefined)
        .map(([n, v]) => `  ${n}: ${v ?? ""}`);
      const missing = found.filter(([, v]) => v === undefined).map(([n]) => n);
      const cpu = cpus();
      return [
        `System: ${type()} ${release()} (${platform()}, ${arch()}), ${String(cpu.length)} CPUs, ${(totalmem() / GB).toFixed(1)} GB memory (${(freemem() / GB).toFixed(1)} GB free)`,
        `Shell for commands: ${options.shell.join(" ")}`,
        `Project folder: ${cwd}`,
        `Git branch: ${branch ?? "(not a git repository)"}`,
        `Node running the agent: ${process.version}`,
        "Installed:",
        ...(installed.length > 0 ? installed : ["  (none of the usual programs)"]),
        ...(missing.length > 0 ? [`Not found: ${missing.join(", ")}`] : []),
      ].join("\n");
    },
  };
}
