import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Project } from "./session.js";

/**
 * The project the agent works on: the one named in the settings, else the
 * git repository holding `cwd` (named after its folder), else `cwd` itself.
 */
export function detectProject(cwd: string, given?: string): Project {
  // An empty setting (AGENT_PROJECT=) names nothing: the folder says which project.
  const named = given?.trim() || undefined;
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) {
      return { name: named ?? basename(dir), path: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: named ?? (basename(start) || "default"), path: start };
}

/** The commit a folder's repository is at (short), or nothing when it is not one. */
export function gitRef(dir: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd: dir, timeout: 5000, windowsHide: true },
      (error, stdout) => {
        const ref = stdout.trim();
        done(error || ref === "" ? undefined : ref);
      },
    );
  });
}
