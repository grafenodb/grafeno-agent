import { Workspace } from "../tools/workspace.js";
import type { AttemptContext, AttemptOutcome, TaskRunner } from "./scheduler.js";
import type { OperationalStore, TaskRecord } from "./store.js";
import type { Policy, Question } from "./policy.js";
import type { WorktreeManager } from "./worktrees.js";

/** Where a task's worker works. */
export type WorkspaceFor = (task: TaskRecord, context: AttemptContext) => Promise<Workspace>;

/** What checks a finished task before it is merged (the verifier, phase A7). */
export type Verify = (
  task: TaskRecord,
  workspace: Workspace,
) => Promise<{ ok: true } | { ok: false; diagnostic: string }>;

export interface PipelineOptions {
  readonly store: OperationalStore;
  /** The project's folder. */
  readonly projectRoot: string;
  /**
   * Worktrees for isolation; without them (not a git repository), every
   * task works in the project's folder and the scheduler's file locks are
   * the only guard.
   */
  readonly worktrees?: WorktreeManager;
  /** The workers, given where each task works (usually a `WorkerPool`). */
  readonly inner: (workspaceFor: WorkspaceFor) => TaskRunner;
  readonly verify?: Verify;
  /** The run's policy: whether merging into the integration branch needs a person. */
  readonly policy?: Policy;
  /** Asks a person (through the interface); without it, what needs a person goes to review. */
  readonly ask?: (question: Question) => Promise<boolean>;
}

/**
 * A task from start to merged: its worker works in the task's own worktree;
 * when it is done, what it changed is committed on the task's branch,
 * checked, and merged into the run's integration branch, as an effect
 * recorded before it runs. A conflict leaves the integration branch as it
 * was and sends the task to review.
 */
export class TaskPipeline implements TaskRunner {
  readonly #inner: TaskRunner;
  readonly #bases = new Map<string, string>();

  constructor(private readonly options: PipelineOptions) {
    this.#inner = options.inner((task, context) => this.workspaceFor(task, context));
  }

  /** Whether tasks get worktrees (the project is a git repository with a commit). */
  async isolated(): Promise<boolean> {
    return this.options.worktrees !== undefined && (await this.options.worktrees.ready());
  }

  /** The commit the run's work starts from: the one stored with the run, else HEAD now (recorded). */
  async base(runId: string): Promise<string> {
    const known = this.#bases.get(runId) ?? this.options.store.run(runId)?.baseCommit;
    if (known) {
      this.#bases.set(runId, known);
      return known;
    }
    const head = await this.#worktrees().head();
    this.#bases.set(runId, head);
    this.options.store.event(runId, "base_commit", { commit: head });
    return head;
  }

  async workspaceFor(task: TaskRecord, context: AttemptContext): Promise<Workspace> {
    if (!(await this.isolated())) return new Workspace(this.options.projectRoot);
    const worktrees = this.#worktrees();
    // From the work merged so far (its dependencies' included), else the base.
    // Found by the first real run: from the base, the tests task did not see
    // the module it was testing.
    const start = (await worktrees.tip(context.runId)) ?? (await this.base(context.runId));
    const worktree = await worktrees.prepare(context.runId, task.id, start);
    return new Workspace(worktree.path);
  }

  async run(task: TaskRecord, context: AttemptContext): Promise<AttemptOutcome> {
    const outcome = await this.#inner.run(task, context);
    if (outcome.status !== "completed") return outcome;
    if (!(await this.isolated())) {
      // No worktrees: the checks run in the project's folder, and nothing is merged.
      if (!this.options.verify) return outcome;
      const verdict = await this.options.verify(task, new Workspace(this.options.projectRoot));
      return verdict.ok ? outcome : { status: "retry", reason: verdict.diagnostic };
    }

    const { store } = this.options;
    const worktrees = this.#worktrees();
    const runId = context.runId;
    const base = await this.base(runId);
    const worktree = await worktrees.prepare(runId, task.id, base);
    const worker = store.task(runId, task.id)?.worker ?? `task-${task.id}`;
    const commit = await worktrees.commit(
      worktree,
      `${task.spec.title}\n\nTask ${task.id} of ${runId}, by ${worker}.`,
      worker,
    );
    if (commit) store.event(runId, "committed", { commit }, task.id);

    if (this.options.verify) {
      const verdict = await this.options.verify(task, new Workspace(worktree.path));
      store.event(runId, "verified", { ok: verdict.ok }, task.id);
      if (!verdict.ok) return { status: "retry", reason: verdict.diagnostic };
    }

    const allowed = this.options.policy?.action("merge-integration") ?? {
      decision: "allow" as const,
      reason: "no policy",
    };
    if (allowed.decision !== "allow") {
      const question: Question = {
        task: task.id,
        worker,
        action: `merge ${worktree.branch} into ${worktrees.integrationBranch(runId)}`,
        reason: allowed.reason,
      };
      const yes =
        allowed.decision === "ask" && this.options.ask ? await this.options.ask(question) : false;
      store.event(
        runId,
        "question",
        { ...question, answer: this.options.ask ? yes : "nobody" },
        task.id,
      );
      if (!yes) return { status: "review", reason: `waiting for approval to ${question.action}` };
    }

    const key = `merge:${runId}:${task.id}`;
    if (store.beginEffect(key, runId, "merge", { branch: worktree.branch }) === "done") {
      return outcome;
    }
    // New, or started before a crash: `integrate` looks before it merges.
    const integration = await worktrees.integrate(runId, task.id, base, worker);
    switch (integration.status) {
      case "conflict":
        store.event(runId, "conflict", { files: integration.files }, task.id);
        return {
          status: "review",
          reason: `merging into ${worktrees.integrationBranch(runId)} conflicts in ${integration.files.join(", ")}`,
        };
      case "nothing":
        store.finishEffect(key);
        return outcome;
      case "merged":
        store.finishEffect(key);
        store.event(
          runId,
          "merged",
          { commit: integration.commit, files: integration.files },
          task.id,
        );
        return outcome;
    }
  }

  /** Removes what is safe to remove once the run is over; says what was kept, and why. */
  async finish(runId: string): Promise<string[]> {
    if (!(await this.isolated())) return [];
    const tasks = this.options.store.tasks(runId);
    const kept = await this.#worktrees().cleanup(
      runId,
      tasks.filter((t) => t.state === "completed" || t.state === "cancelled").map((t) => t.id),
    );
    this.options.store.event(runId, "cleanup", { kept });
    return kept;
  }

  #worktrees(): WorktreeManager {
    if (!this.options.worktrees) throw new Error("This run has no worktrees");
    return this.options.worktrees;
  }
}
