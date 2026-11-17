import { Workspace } from "../tools/workspace.js";
import type { AttemptContext, AttemptOutcome, TaskRunner } from "./scheduler.js";
import type { OperationalStore, TaskRecord } from "./store.js";
import type { Policy, Question } from "./policy.js";
import type { WorktreeManager } from "./worktrees.js";
import { reviewFeedback, type ReviewVerdict } from "./review.js";
import {
  checkDoubt,
  checkLine,
  MAX_CHECK_REPAIRS,
  type CheckDoubt,
  type CheckJudgement,
} from "./checks-repair.js";

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
  /**
   * Judges a check that failed in a telling way (its own command broken, or
   * the same failure again after the worker had its diagnostic): the plan's
   * author says whether the check or the work is wrong, and corrects the
   * check. Without it, a failed check always goes back to the worker.
   */
  readonly judgeChecks?: (
    task: TaskRecord,
    doubt: CheckDoubt,
    diagnostic: string,
    diff: string,
    context: AttemptContext,
  ) => Promise<{ judgement: CheckJudgement; judge: string }>;
  /** The run's policy: whether merging into the integration branch needs a person. */
  readonly policy?: Policy;
  /** Told when a task's work was merged into the integration branch. */
  readonly onMerged?: (runId: string, taskId: string) => Promise<void>;
  /** Asks a person (through the interface); without it, what needs a person goes to review. */
  readonly ask?: (question: Question) => Promise<boolean>;
  /**
   * Cross review (phase D5): after its checks pass, a task's change is read
   * by a reviewer on another model, which may send it back with issues.
   * Without it, no review.
   */
  readonly review?: {
    /** Which tasks are reviewed. */
    readonly for: (task: TaskRecord) => boolean;
    readonly ask: (
      task: TaskRecord,
      diff: string,
      context: AttemptContext,
      summary?: string,
    ) => Promise<{ verdict: ReviewVerdict; reviewer: string; independent: boolean }>;
    /** Times a review may send a task back. Default: 2 (3 for a leader). */
    readonly rounds?: number;
    /**
     * The reviewer is the run's leader: its approval is recorded as such,
     * its suggestions go to the tasks after this one.
     */
    readonly leader?: boolean;
    /** The scheduler's attempts per task: a send-back never spends the last one. Default: 3. */
    readonly maxAttempts?: number;
  };
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

  /**
   * The task's checks, and, when they failed in a telling way, the plan's
   * author asked whether they are wrong: corrected checks replace them and
   * run on the same work at once, so a worker that did the work is not sent
   * back for a check that could not pass.
   */
  async #checked(
    task: TaskRecord,
    workspace: Workspace,
    context: AttemptContext,
    diff: () => Promise<string>,
  ): Promise<{ ok: true } | { ok: false; diagnostic: string }> {
    const verify = this.options.verify;
    if (!verify) return { ok: true };
    const verdict = await verify(task, workspace);
    const judge = this.options.judgeChecks;
    if (verdict.ok || !judge) return verdict;
    const { store } = this.options;
    const runId = context.runId;
    const mine = store.events(runId).filter((e) => e.taskId === task.id);
    const judged = mine.filter((e) => e.kind === "checks_judged").length;
    if (judged >= MAX_CHECK_REPAIRS) return verdict;
    const previous = mine.filter((e) => e.kind === "attempt_ended").at(-1)?.data.reason;
    const doubt = checkDoubt(
      verdict.diagnostic,
      typeof previous === "string" ? previous : undefined,
    );
    if (!doubt) return verdict;
    const asked = await judge(task, doubt, verdict.diagnostic, await diff(), context);
    const { judgement } = asked;
    store.event(
      runId,
      "checks_judged",
      {
        doubt,
        judge: asked.judge,
        verdict: judgement.verdict,
        ...(judgement.verdict === "none" ? { reason: judgement.reason } : { why: judgement.why }),
      },
      task.id,
    );
    if (judgement.verdict !== "check") return verdict;
    store.setAcceptance(runId, task.id, judgement.acceptance, {
      doubt,
      judge: asked.judge,
      why: judgement.why,
      before: task.spec.acceptance.map(checkLine),
      after: judgement.acceptance.map(checkLine),
    });
    const corrected = store.task(runId, task.id) ?? task;
    return verify(corrected, workspace);
  }

  async run(task: TaskRecord, context: AttemptContext): Promise<AttemptOutcome> {
    const outcome = await this.#inner.run(task, context);
    if (outcome.status !== "completed") return outcome;
    if (!(await this.isolated())) {
      // No worktrees: the checks run in the project's folder, and nothing is merged.
      if (!this.options.verify) return outcome;
      const verdict = await this.#checked(
        task,
        new Workspace(this.options.projectRoot),
        context,
        () => Promise.resolve(""),
      );
      // Recorded here too: what the checks said is what the router learns from.
      this.options.store.event(context.runId, "verified", { ok: verdict.ok }, task.id);
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
      const verdict = await this.#checked(task, new Workspace(worktree.path), context, () =>
        worktrees.diff(runId, task.id, base),
      );
      store.event(runId, "verified", { ok: verdict.ok }, task.id);
      if (!verdict.ok) return { status: "retry", reason: verdict.diagnostic };
    }

    // Phase D5: the checks passed; a reviewer may send the task back, never approve it.
    const review = this.options.review;
    if (review?.for(task)) {
      const diff = await worktrees.diff(runId, task.id, base);
      const asked = await review.ask(task, diff, context, outcome.summary);
      const verdict = asked.verdict;
      const leader = review.leader === true;
      if (verdict.verdict === "none") {
        store.event(
          runId,
          "review_skipped",
          { reviewer: asked.reviewer, reason: verdict.reason },
          task.id,
        );
      } else {
        const before = store
          .events(runId)
          .filter(
            (e) => e.taskId === task.id && e.kind === "reviewed" && e.data.verdict === "changes",
          ).length;
        store.event(
          runId,
          "reviewed",
          {
            reviewer: asked.reviewer,
            independent: asked.independent,
            verdict: verdict.verdict,
            issues: verdict.verdict === "changes" ? verdict.issues.length : 0,
            round: before + 1,
            ...(leader ? { leader: true } : {}),
            ...(verdict.verdict === "changes"
              ? { found: verdict.issues.map((i) => `${i.file ? `${i.file}: ` : ""}${i.issue}`) }
              : {}),
            ...(verdict.suggestions && verdict.suggestions.length > 0
              ? { suggestions: verdict.suggestions }
              : {}),
          },
          task.id,
        );
        if (verdict.verdict === "changes") {
          const left = (review.maxAttempts ?? 3) - task.attempts;
          const feedback = reviewFeedback(asked.reviewer, verdict.issues, {
            leader,
            ...(verdict.suggestions ? { suggestions: verdict.suggestions } : {}),
          });
          if (before + 1 <= (review.rounds ?? (leader ? 3 : 2)) && left > 0) {
            return { status: "retry", reason: feedback };
          }
          return {
            status: "review",
            reason: `${leader ? "the leader" : "the reviewer"} (${asked.reviewer}) still asks for changes after ${String(before + 1)} round${before === 0 ? "" : "s"}; a person decides. ${feedback}`,
          };
        }
      }
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
        // A failure to deliver it never fails the task: its work is merged.
        await this.options.onMerged?.(runId, task.id).catch(() => undefined);
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
