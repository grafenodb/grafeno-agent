import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Runs git with these arguments in a folder; resolves with what it printed. */
export type Git = (
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
) => Promise<GitResult>;

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runGit: Git = (cwd, args, env) =>
  new Promise((done) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });

export interface Worktree {
  readonly path: string;
  readonly branch: string;
}

export type Integration =
  | { readonly status: "merged"; readonly commit: string; readonly files: readonly string[] }
  | { readonly status: "nothing"; readonly reason: string }
  | { readonly status: "conflict"; readonly files: readonly string[] };

export interface WorktreeManagerOptions {
  /** The project: a git repository. Its working tree is never written. */
  readonly repo: string;
  /** Where worktrees live: the agent's data folder, outside the project. */
  readonly root: string;
  readonly git?: Git;
}

/** An identity for commits made for a worker: who did it is in the author. */
function author(worker: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: `Grafeno Agent (${worker})`,
    GIT_AUTHOR_EMAIL: "worker@grafeno-agent.invalid",
    GIT_COMMITTER_NAME: "Grafeno Agent",
    GIT_COMMITTER_EMAIL: "agent@grafeno-agent.invalid",
  };
}

/**
 * Each task of a run in a git worktree of its own, on a branch of its own
 * (`grafeno/<run>/<task>`) from the run's base commit; finished work merged
 * into the run's integration branch (`grafeno/<run>/integration`) in a
 * worktree of its own too. The user's working tree and branches are never
 * written, except by `mergeIntoCurrent` (phase D6, extended mode only);
 * worktrees are removed only when that loses nothing.
 */
export class WorktreeManager {
  readonly #git: Git;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly repo: string;
  readonly root: string;

  constructor(options: WorktreeManagerOptions) {
    this.repo = resolve(options.repo);
    this.root = resolve(options.root);
    this.#git = options.git ?? runGit;
  }

  /** Whether the project is a git repository with at least one commit. */
  async ready(): Promise<boolean> {
    const head = await this.#git(this.repo, ["rev-parse", "--verify", "HEAD"]);
    return head.code === 0;
  }

  /** The commit a run starts from: the project's HEAD. */
  async head(): Promise<string> {
    return (await this.#must(this.repo, ["rev-parse", "HEAD"])).trim();
  }

  /** Files the user changed and did not commit: the run does not see them (it starts from HEAD). */
  async uncommitted(): Promise<string[]> {
    const status = await this.#must(this.repo, ["status", "--porcelain"]);
    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  branchFor(runId: string, taskId: string): string {
    return `grafeno/${short(runId)}/${taskId}`;
  }

  integrationBranch(runId: string): string {
    return `grafeno/${short(runId)}/integration`;
  }

  pathFor(runId: string, taskId: string): string {
    return join(this.root, short(runId), taskId);
  }

  /**
   * The integration branch's latest commit, once the run has one: the work
   * of every task merged so far. A task starts from it, so it sees what its
   * dependencies did.
   */
  async tip(runId: string): Promise<string | undefined> {
    const result = await this.#git(this.repo, [
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${this.integrationBranch(runId)}`,
    ]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** The task's worktree, made from `base` the first time, the same one after a restart. */
  async prepare(runId: string, taskId: string, base: string): Promise<Worktree> {
    const path = this.pathFor(runId, taskId);
    const branch = this.branchFor(runId, taskId);
    return this.#worktree(path, branch, base);
  }

  /** The run's integration worktree. */
  async integration(runId: string, base: string): Promise<Worktree> {
    return this.#worktree(
      join(this.root, short(runId), "_integration"),
      this.integrationBranch(runId),
      base,
    );
  }

  /** Commits what the worker changed in its worktree; nothing when it changed nothing. */
  async commit(worktree: Worktree, message: string, worker: string): Promise<string | undefined> {
    await this.#must(worktree.path, ["add", "--all"]);
    const staged = await this.#git(worktree.path, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return undefined;
    await this.#must(worktree.path, ["commit", "--no-verify", "-m", message], author(worker));
    return (await this.#must(worktree.path, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * Files the task changed on its branch since the commit the branch was
   * made from (the base, or the integration branch's tip of that moment):
   * what its dependencies did is not counted as its own, before or after
   * the merge.
   */
  async changed(runId: string, taskId: string, base: string): Promise<string[]> {
    const branch = this.branchFor(runId, taskId);
    const from = (await this.startOf(branch)) ?? base;
    const out = await this.#must(this.repo, ["diff", "--name-only", from, branch]);
    return out.split("\n").filter(Boolean);
  }

  /**
   * What the task changed on its branch, as a diff, from where the branch
   * started (as `changed` counts it): what a reviewer reads (phase D5).
   * Cut at `max` characters, saying so.
   */
  async diff(runId: string, taskId: string, base: string, max = 40_000): Promise<string> {
    const branch = this.branchFor(runId, taskId);
    const from = (await this.startOf(branch)) ?? base;
    const out = await this.#must(this.repo, ["diff", from, branch]);
    return out.length <= max
      ? out
      : `${out.slice(0, max)}\n... (${String(out.length - max)} characters of the diff left out)`;
  }

  /**
   * The commit a branch was made from: the oldest entry of its reflog, which
   * git keeps for every branch it makes (and which survives a restart).
   */
  async startOf(branch: string): Promise<string | undefined> {
    const log = await this.#git(this.repo, [
      "reflog",
      "show",
      "--format=%H",
      `refs/heads/${branch}`,
    ]);
    if (log.code !== 0) return undefined;
    return log.stdout.trim().split("\n").filter(Boolean).at(-1);
  }

  /** Whether the task's branch is already in the integration branch (a merge done before a crash). */
  async merged(runId: string, taskId: string): Promise<boolean> {
    const check = await this.#git(this.repo, [
      "merge-base",
      "--is-ancestor",
      this.branchFor(runId, taskId),
      this.integrationBranch(runId),
    ]);
    return check.code === 0;
  }

  /**
   * Merges the task's branch into the run's integration branch. A conflict
   * is undone (the integration branch stays as it was) and its files are
   * returned, for a person or another attempt to settle.
   */
  async integrate(
    runId: string,
    taskId: string,
    base: string,
    worker: string,
  ): Promise<Integration> {
    // One merge at a time into a run's integration worktree.
    return this.#serial(`integrate:${runId}`, () => this.#integrate(runId, taskId, base, worker));
  }

  async #integrate(
    runId: string,
    taskId: string,
    base: string,
    worker: string,
  ): Promise<Integration> {
    const target = await this.integration(runId, base);
    const branch = this.branchFor(runId, taskId);
    // A merge a crash left half done is undone first.
    if ((await this.#git(target.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) {
      await this.#git(target.path, ["merge", "--abort"]);
    }
    const files = await this.changed(runId, taskId, base);
    if (files.length === 0) return { status: "nothing", reason: "the task changed no files" };
    if (await this.merged(runId, taskId)) {
      return {
        status: "merged",
        commit: (await this.#must(target.path, ["rev-parse", "HEAD"])).trim(),
        files,
      };
    }
    const merge = await this.#git(
      target.path,
      ["merge", "--no-ff", "--no-edit", "-m", `Merge ${taskId} (${worker})`, branch],
      author(worker),
    );
    if (merge.code !== 0) {
      const conflicted = await this.#git(target.path, ["diff", "--name-only", "--diff-filter=U"]);
      await this.#git(target.path, ["merge", "--abort"]);
      const list = conflicted.stdout.split("\n").filter(Boolean);
      // A merge that failed without conflicts is an error to retry, not a conflict.
      if (list.length === 0) {
        throw new Error(`git merge ${branch} failed: ${(merge.stderr || merge.stdout).trim()}`);
      }
      return { status: "conflict", files: list };
    }
    return {
      status: "merged",
      commit: (await this.#must(target.path, ["rev-parse", "HEAD"])).trim(),
      files,
    };
  }

  /** The branch the user's working tree is on; nothing when HEAD is detached. */
  async currentBranch(): Promise<string | undefined> {
    const result = await this.#git(this.repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  /** Whether `commit` is already in `ref` (default: the user's HEAD). */
  async contains(commit: string, ref = "HEAD"): Promise<boolean> {
    return (await this.#git(this.repo, ["merge-base", "--is-ancestor", commit, ref])).code === 0;
  }

  /** Where the user's branch was before a run's work was merged into it (phase D6). */
  rollbackRef(runId: string): string {
    return `refs/grafeno/${short(runId)}/rollback`;
  }

  /**
   * Merges the run's integration branch into the branch the user is on, in
   * their own working tree (phase D6), after keeping where it was under the
   * run's rollback ref. The caller has checked the tree is clean. The
   * user's hooks run. A conflict, or a merge refused, is undone at once.
   */
  async mergeIntoCurrent(
    runId: string,
    message: string,
  ): Promise<
    | { readonly status: "merged"; readonly commit: string; readonly before: string }
    | { readonly status: "conflict"; readonly files: readonly string[] }
    | { readonly status: "refused"; readonly reason: string }
  > {
    return this.#serial("repo", async () => {
      const before = (await this.#must(this.repo, ["rev-parse", "HEAD"])).trim();
      await this.#must(this.repo, ["update-ref", this.rollbackRef(runId), before]);
      const merge = await this.#git(
        this.repo,
        ["merge", "--no-ff", "--no-edit", "-m", message, this.integrationBranch(runId)],
        author("orchestrator"),
      );
      if (merge.code === 0) {
        return {
          status: "merged" as const,
          commit: (await this.#must(this.repo, ["rev-parse", "HEAD"])).trim(),
          before,
        };
      }
      const conflicted = await this.#git(this.repo, ["diff", "--name-only", "--diff-filter=U"]);
      if ((await this.#git(this.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) {
        await this.#git(this.repo, ["merge", "--abort"]);
      }
      const files = conflicted.stdout.split("\n").filter(Boolean);
      return files.length > 0
        ? { status: "conflict" as const, files }
        : { status: "refused" as const, reason: (merge.stderr || merge.stdout).trim() };
    });
  }

  /**
   * Undoes a merge made by `mergeIntoCurrent`: the user's branch goes back
   * to the rollback ref, only while HEAD is still that merge, and with
   * `reset --keep`, which refuses rather than lose a change the user made
   * meanwhile. Says why not otherwise.
   */
  async undoMerge(runId: string, merge: string): Promise<string | undefined> {
    return this.#serial("repo", async () => {
      const head = (await this.#must(this.repo, ["rev-parse", "HEAD"])).trim();
      if (head !== merge) return `the branch moved on since the merge (now at ${head.slice(0, 8)})`;
      const reset = await this.#git(this.repo, ["reset", "-q", "--keep", this.rollbackRef(runId)]);
      return reset.code === 0 ? undefined : (reset.stderr || reset.stdout).trim();
    });
  }

  /**
   * Removes a task's worktree when nothing would be lost: its changes are
   * committed (and, unless `cancelled`, merged). Returns why not otherwise.
   */
  async remove(
    runId: string,
    taskId: string,
    options: { cancelled?: boolean } = {},
  ): Promise<string | undefined> {
    const path = this.pathFor(runId, taskId);
    if (!existsSync(path)) return undefined;
    const status = await this.#git(path, ["status", "--porcelain"]);
    if (status.code !== 0) return `cannot read ${path}`;
    if (status.stdout.trim() !== "") return `${path} has changes that are not committed`;
    if (
      !options.cancelled &&
      !(await this.merged(runId, taskId)) &&
      (await this.#hasCommits(runId, taskId))
    ) {
      return `the branch of ${taskId} is not merged into the integration branch`;
    }
    await this.#serial("repo", () => this.#must(this.repo, ["worktree", "remove", path]));
    return undefined;
  }

  /** Removes the run's worktree folders that are safe to remove; the branches stay for the user. */
  async cleanup(runId: string, taskIds: readonly string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const taskId of taskIds) {
      const why = await this.remove(runId, taskId);
      if (why) kept.push(why);
    }
    const integration = join(this.root, short(runId), "_integration");
    if (existsSync(integration)) {
      const status = await this.#git(integration, ["status", "--porcelain"]);
      if (status.code === 0 && status.stdout.trim() === "") {
        await this.#git(this.repo, ["worktree", "remove", integration]);
      } else kept.push(`${integration} has changes that are not committed`);
    }
    await this.#git(this.repo, ["worktree", "prune"]);
    return kept;
  }

  async #hasCommits(runId: string, taskId: string): Promise<boolean> {
    const branch = this.branchFor(runId, taskId);
    const count = await this.#git(this.repo, [
      "rev-list",
      "--count",
      `${this.integrationBranch(runId)}..${branch}`,
    ]);
    return count.code === 0 && Number(count.stdout.trim()) > 0;
  }

  async #worktree(path: string, branch: string, base: string): Promise<Worktree> {
    // Worktrees are added one at a time: git locks the repository's list of them.
    return this.#serial("repo", () => this.#addWorktree(path, branch, base));
  }

  async #addWorktree(path: string, branch: string, base: string): Promise<Worktree> {
    if (existsSync(join(path, ".git"))) return { path, branch };
    mkdirSync(join(path, ".."), { recursive: true });
    const exists =
      (await this.#git(this.repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code === 0;
    await this.#must(
      this.repo,
      exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base],
    );
    return { path, branch };
  }

  /** Runs `work` after whatever runs under the same key: one at a time per key. */
  async #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(key) ?? Promise.resolve();
    const next = before.then(work, work);
    this.#queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async #must(cwd: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
    const result = await this.#git(cwd, args, env);
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
  }
}

/** The run's id, short, for branch names and paths (Windows keeps paths short). */
function short(runId: string): string {
  return runId.replace(/^run-/, "").slice(-8);
}
