import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { settingsPath } from "./settings-file.js";

/**
 * The person's projects: a name and a folder each, kept next to the
 * settings (`projects.json`). A session always works in one project's
 * folder; its conversations, runs and memory are that project's.
 */
export interface ProjectEntry {
  readonly name: string;
  readonly path: string;
  readonly added: string;
}

export function projectsFile(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(settingsPath(env)), "projects.json");
}

export function loadProjects(file = projectsFile()): ProjectEntry[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { projects?: unknown };
    if (!Array.isArray(data.projects)) return [];
    return data.projects.filter(
      (p): p is ProjectEntry =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as ProjectEntry).name === "string" &&
        typeof (p as ProjectEntry).path === "string",
    );
  } catch {
    return [];
  }
}

function save(projects: readonly ProjectEntry[], file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

/** Why a project name cannot be used, or undefined. */
export function projectNameProblem(name: string): string | undefined {
  return NAME.test(name.trim())
    ? undefined
    : "a project's name has 1 to 64 letters, digits, spaces, dots, dashes or underscores";
}

/**
 * Adds a folder as a project (made when it does not exist, with a git
 * repository so runs can give each task its own worktree). A folder or a
 * name already listed is not added twice: the entry found is returned.
 */
export function addProject(
  folder: string,
  name: string | undefined,
  options: { readonly file?: string; readonly create?: boolean; readonly git?: boolean } = {},
): ProjectEntry {
  const file = options.file ?? projectsFile();
  const path = resolve(folder);
  const projects = loadProjects(file);
  const known = projects.find((p) => resolve(p.path) === path);
  if (known) return known;
  const chosen = (name ?? basename(path)).trim();
  const why = projectNameProblem(chosen);
  if (why) throw new Error(why);
  if (projects.some((p) => p.name.toLowerCase() === chosen.toLowerCase())) {
    throw new Error(`There is a project named ${chosen} already.`);
  }
  if (!existsSync(path)) {
    if (options.create !== true) throw new Error(`${path} does not exist.`);
    mkdirSync(path, { recursive: true });
  }
  if (options.git !== false && !existsSync(join(path, ".git"))) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: path, windowsHide: true, stdio: "ignore" });
    } catch {
      // Without git the project still works; runs then share its folder.
    }
  }
  const entry: ProjectEntry = { name: chosen, path, added: new Date().toISOString() };
  save([...projects, entry], file);
  return entry;
}

/** Removes a project from the list (its folder is left as it is); false when not listed. */
export function removeProject(name: string, file = projectsFile()): boolean {
  const projects = loadProjects(file);
  const rest = projects.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase());
  if (rest.length === projects.length) return false;
  save(rest, file);
  return true;
}
