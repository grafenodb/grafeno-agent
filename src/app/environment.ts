import { execFile } from "node:child_process";

/** Where the agent is working: the project's git state, when it is a repository. */
export interface Environment {
  readonly branch?: string;
  /** Files changed and not committed. */
  readonly changes?: number;
  /** Commits not pushed, when the branch tracks one. */
  readonly ahead?: number;
}

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

/** The project's git branch and how many files changed; empty outside a repository. */
export async function readEnvironment(cwd: string): Promise<Environment> {
  const status = await git(cwd, ["status", "--porcelain=v1", "--branch"]);
  if (status === undefined) return {};
  const lines = status.split("\n").filter((line) => line !== "");
  const head = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
  const branch = head
    .replace(/^No commits yet on /, "")
    .split("...")[0]
    ?.trim();
  const ahead = /\[ahead (\d+)/.exec(head)?.[1];
  return {
    ...(branch ? { branch } : {}),
    changes: lines.filter((line) => !line.startsWith("## ")).length,
    ...(ahead === undefined ? {} : { ahead: Number(ahead) }),
  };
}
