import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Project } from "./session.js";

/**
 * The project the agent works on: the one named in the settings, else the
 * git repository holding `cwd` (named after its folder), else `cwd` itself.
 */
export function detectProject(cwd: string, named?: string): Project {
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
