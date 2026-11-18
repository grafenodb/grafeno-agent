import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { settingsPath } from "./settings-file.js";

/**
 * The person's projects: a name, a folder and a namespace in Grafeno each,
 * kept next to the settings (`projects.json`). A project is a place for
 * sessions with shared memory: every session opened in its folder (or a
 * folder inside it) reads and writes the project's own namespace, so what
 * one learns the others know. Sessions outside any project share one
 * namespace of their own (`GRAFENO_NAMESPACE`). Deleting a project drops
 * its namespace, its conversations and its runs: nothing is left behind
 * but its folder, which is the person's.
 */
export interface ProjectEntry {
  readonly name: string;
  readonly path: string;
  readonly added: string;
  /** Its memory in Grafeno: made when the project's first session starts. */
  readonly namespace: string;
}

export function projectsFile(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(settingsPath(env)), "projects.json");
}

/** The namespace sessions outside any project share; projects' own namespaces start with it. */
export function sharedNamespace(env: Record<string, string | undefined> = process.env): string {
  return env.GRAFENO_NAMESPACE?.trim() || "grafeno-agent";
}

/**
 * Whose memory a namespace is, when it is the agent's: General (sessions
 * outside a project) or a project's. Others on the server are not its own.
 */
export function memoryOwner(namespace: string): string | undefined {
  if (namespace === sharedNamespace()) return "General (outside projects)";
  try {
    const project = loadProjects().find((p) => p.namespace === namespace);
    return project ? `Project ${project.name}` : undefined;
  } catch {
    return undefined;
  }
}

/** A project's namespace: the shared one, `--`, and the project's name made safe. */
export function projectNamespace(base: string, name: string): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  return `${base}--${slug}`;
}

export function loadProjects(file = projectsFile(), base = sharedNamespace()): ProjectEntry[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { projects?: unknown };
    if (!Array.isArray(data.projects)) return [];
    return data.projects
      .filter(
        (p): p is Omit<ProjectEntry, "namespace"> & { namespace?: string } =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as ProjectEntry).name === "string" &&
          typeof (p as ProjectEntry).path === "string",
      )
      .map((p) => ({
        name: p.name,
        path: p.path,
        added: typeof p.added === "string" ? p.added : "",
        // Listed before projects had a namespace: given the one it would get now.
        namespace:
          typeof p.namespace === "string" && p.namespace !== ""
            ? p.namespace
            : projectNamespace(base, p.name),
      }));
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

/** The project a folder belongs to: the one whose folder holds it (the deepest), if any. */
export function projectAt(
  folder: string,
  file = projectsFile(),
  base = sharedNamespace(),
): ProjectEntry | undefined {
  const here = resolve(folder);
  const inside = (root: string) => {
    const rel = relative(resolve(root), here);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return loadProjects(file, base)
    .filter((p) => inside(p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Adds a folder as a project (made when it does not exist, with a git
 * repository so runs can give each task its own worktree), with a
 * namespace of its own. A folder already listed is not added twice: the
 * entry found is returned.
 */
export function addProject(
  folder: string,
  name: string | undefined,
  options: {
    readonly file?: string;
    readonly create?: boolean;
    readonly git?: boolean;
    readonly base?: string;
  } = {},
): ProjectEntry {
  const file = options.file ?? projectsFile();
  const base = options.base ?? sharedNamespace();
  const path = resolve(folder);
  const projects = loadProjects(file, base);
  const known = projects.find((p) => resolve(p.path) === path);
  if (known) return known;
  const chosen = (name ?? basename(path)).trim();
  const why = projectNameProblem(chosen);
  if (why) throw new Error(why);
  if (projects.some((p) => p.name.toLowerCase() === chosen.toLowerCase())) {
    throw new Error(`There is a project named ${chosen} already.`);
  }
  let namespace = projectNamespace(base, chosen);
  for (let n = 2; projects.some((p) => p.namespace === namespace); n++) {
    namespace = `${projectNamespace(base, chosen)}-${String(n)}`;
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
  const entry: ProjectEntry = { name: chosen, path, added: new Date().toISOString(), namespace };
  save([...projects, entry], file);
  return entry;
}

/** Takes a project off the list (nothing else); false when it was not listed. */
export function removeProject(name: string, file = projectsFile()): boolean {
  const projects = loadProjects(file);
  const rest = projects.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase());
  if (rest.length === projects.length) return false;
  save(rest, file);
  return true;
}

/** What deleting a project removed, and what could not be. */
export interface ProjectDeletion {
  readonly project: ProjectEntry;
  readonly namespace: "dropped" | "absent" | { readonly failed: string };
  readonly sessions: number;
  readonly runs: boolean;
}

export interface DeleteProjectOptions {
  readonly file?: string;
  /** Drops the project's namespace in Grafeno; resolves to whether it existed. */
  readonly dropNamespace: (namespace: string) => Promise<boolean>;
  /** Where conversations are kept (one folder per project). */
  readonly sessionsDir: string;
  /** Where each project's runs are kept (`runs/<project>.db`). */
  readonly dataDir: string;
}

/** A project's name as the folder name its conversations and runs are kept under. */
function folderOf(project: string): string {
  const safe = project.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe === "" ? "_" : safe;
}

/** What deleting a project would remove besides its namespace: its conversations, and whether it has runs. */
export function projectFootprint(
  project: Pick<ProjectEntry, "name">,
  where: { readonly sessionsDir: string; readonly dataDir: string },
): { readonly sessions: number; readonly runs: boolean } {
  const folder = join(where.sessionsDir, folderOf(project.name));
  let sessions = 0;
  try {
    sessions = readdirSync(folder).filter((f) => f.endsWith(".json")).length;
  } catch {
    // No conversations yet.
  }
  const runs = existsSync(join(where.dataDir, "runs", `${folderOf(project.name)}.db`));
  return { sessions, runs };
}

/**
 * Deletes a project and what the agent kept of it: its namespace in
 * Grafeno (with everything in it), its conversations and its runs; then
 * takes it off the list. Its folder, with the person's code, is left as it
 * is. When the namespace cannot be dropped, nothing else is deleted, so the
 * project can be deleted again once it can.
 */
export async function deleteProject(
  name: string,
  options: DeleteProjectOptions,
): Promise<ProjectDeletion> {
  const file = options.file ?? projectsFile();
  const project = loadProjects(file).find(
    (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!project) throw new Error(`No project is named ${name}.`);
  let namespace: ProjectDeletion["namespace"];
  try {
    namespace = (await options.dropNamespace(project.namespace)) ? "dropped" : "absent";
  } catch (error) {
    return {
      project,
      namespace: { failed: error instanceof Error ? error.message : String(error) },
      sessions: 0,
      runs: false,
    };
  }
  const sessionsFolder = join(options.sessionsDir, folderOf(project.name));
  let sessions = 0;
  if (existsSync(sessionsFolder)) {
    try {
      sessions = readdirSync(sessionsFolder).filter((f) => f.endsWith(".json")).length;
      rmSync(sessionsFolder, { recursive: true, force: true });
    } catch {
      // Left for another try; the namespace is gone already.
    }
  }
  let runs = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const db = join(options.dataDir, "runs", `${folderOf(project.name)}.db${suffix}`);
    if (existsSync(db)) {
      rmSync(db, { force: true });
      runs = true;
    }
  }
  // The runs' copies of the project (git worktrees): removed, and git told to forget them.
  const worktrees = join(options.dataDir, "worktrees", folderOf(project.name));
  if (existsSync(worktrees)) {
    try {
      rmSync(worktrees, { recursive: true, force: true });
      execFileSync("git", ["worktree", "prune"], {
        cwd: project.path,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // A copy still in use, or the folder is not a repository any more: left as it is.
    }
  }
  removeProject(project.name, file);
  return { project, namespace, sessions, runs };
}
