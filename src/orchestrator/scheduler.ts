import { normalize } from "node:path";
import { FINAL_STATES, type RunState, type TaskState } from "./states.js";
import { isReplaced, type OperationalStore, type TaskRecord } from "./store.js";

/** What one attempt of a task came to. */
export type AttemptOutcome =
  /** Its checks passed. */
  | { readonly status: "completed"; readonly summary?: string }
  /** A person must decide: a conflict, a question, a check that needs eyes. */
  | { readonly status: "review"; readonly reason: string }
  /** It may work another time: a lost connection, a crashed worker, a flaky check. */
  | { readonly status: "retry"; readonly reason: string }
  /** It will not work by trying again. */
  | { readonly status: "failed"; readonly reason: string }
  /** The provider's usage limit is reached: the run waits, the task is not to blame. */
  | { readonly status: "quota"; readonly reason: string; readonly resetsAt?: Date }
  /** Its provider cannot take it now; another one will: the task is not to blame. */
  | { readonly status: "moved"; readonly reason: string };

export interface AttemptContext {
  readonly runId: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
  /** Aborted on cancel, pause with cancel, or timeout. */
  readonly signal: AbortSignal;
  /** What the tasks it depends on came to: only what it needs, not their conversations. */
  readonly inputs: readonly TaskInput[];
  /** Why the last attempt did not finish, for the worker to do better. */
  readonly previous?: string;
  /** Records who works on it (worker, model, effort) in the store. */
  assign(assignment: { worker: string; model?: string; effort?: string }): void;
  /** Records something about the attempt in the run's events (memories stored, files…). */
  note(kind: string, data: Record<string, unknown>): void;
}

/** A completed dependency, as a worker is told of it. */
export interface TaskInput {
  readonly id: string;
  readonly title: string;
  /** What its worker reported when its checks passed. */
  readonly summary?: string;
  /** The memories its worker stored (decisions, contracts…), by id in Grafeno. */
  readonly memories?: readonly string[];
  /** What the run's leader suggested when it approved it, for the tasks after it. */
  readonly suggestions?: readonly string[];
}

/**
 * Runs one attempt of one task: a worker (phase A4) or, in tests, a script.
 * The scheduler decides what runs and when; the runner only does the work
 * and says how it went. It must honour the signal.
 */
export interface TaskRunner {
  run(task: TaskRecord, context: AttemptContext): Promise<AttemptOutcome>;
}

export interface SchedulerOptions {
  readonly store: OperationalStore;
  readonly runner: TaskRunner;
  /** Tasks running at once. Default: 3. */
  readonly maxWorkers?: number;
  /** Attempts per task, the first included. Default: 3. */
  readonly maxAttempts?: number;
  /** Time one attempt may take. Default: 20 minutes. */
  readonly attemptTimeoutMs?: number;
  /** Told of what happens, as it happens (the store keeps it too). */
  readonly onChange?: (change: SchedulerChange) => void;
  /**
   * A run-wide limit (phase D2): why nothing new may start, or undefined
   * while there is room. Checked before tasks start; what runs finishes.
   */
  readonly limit?: (runId: string) => string | undefined;
}

export type SchedulerChange =
  | {
      readonly type: "task";
      readonly task: string;
      readonly state: TaskState;
      readonly reason?: string;
    }
  | { readonly type: "run"; readonly state: RunState; readonly reason?: string };

/** Why a task was stopped by the scheduler rather than by its runner. */
class Stop extends Error {
  constructor(readonly why: "cancel" | "timeout") {
    super(why);
  }
}

/**
 * The deterministic scheduler: from the plan's DAG and the store, it starts
 * what is ready, in parallel up to `maxWorkers`, never two tasks that touch
 * the same files at once, with a timeout per attempt and bounded retries;
 * it blocks what depends on a failure, pauses and cancels, and resumes a
 * run another process left. No model decides anything here.
 */
export class Scheduler {
  readonly #options: Required<Omit<SchedulerOptions, "onChange" | "limit">> &
    Pick<SchedulerOptions, "onChange" | "limit">;
  readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #pausing = false;
  #cancelling = false;
  #quota: { reason: string; resetsAt?: Date } | undefined;
  /** A run-wide limit reached: why the run pauses. */
  #limited: string | undefined;

  constructor(options: SchedulerOptions) {
    this.#options = {
      maxWorkers: 3,
      maxAttempts: 3,
      attemptTimeoutMs: 20 * 60_000,
      ...options,
    };
  }

  /** Tasks running now, by id. */
  get running(): readonly string[] {
    return [...this.#running.keys()];
  }

  /**
   * Drives the run until nothing more can happen now: every task final
   * (completed / failed), waiting for a person (review), paused, cancelled
   * or stopped by the provider's limit. Returns the run's state then.
   */
  async run(runId: string): Promise<RunState> {
    const { store } = this.#options;
    const run = store.run(runId);
    if (!run) throw new Error(`No run ${runId}`);
    this.#pausing = false;
    this.#cancelling = false;
    this.#quota = undefined;
    this.#limited = undefined;
    if (run.state !== "running") this.#setRun(runId, "running", "resumed");
    this.#recover(runId);

    for (;;) {
      if (!this.#holding()) this.#limited = this.#options.limit?.(runId);
      if (!this.#holding()) {
        this.#promote(runId);
        this.#startReady(runId);
      }
      if (this.#running.size === 0) break;
      await Promise.race([...this.#running.values()].map((r) => r.done));
    }
    return this.#settle(runId);
  }

  /** Whether nothing new may start: pausing, cancelling, or held by the provider's limit. */
  #holding(): boolean {
    return (
      this.#pausing || this.#cancelling || this.#quota !== undefined || this.#limited !== undefined
    );
  }

  /** Starts nothing new; what runs finishes, then the run is paused. */
  pause(): void {
    this.#pausing = true;
  }

  /** Stops what runs and cancels every task that is not final. */
  cancel(): void {
    this.#cancelling = true;
    for (const { controller } of this.#running.values()) controller.abort(new Stop("cancel"));
  }

  /** Tasks left running by a process that ended: their attempt is over. */
  #recover(runId: string): void {
    for (const task of this.#options.store.tasks(runId)) {
      if (task.state !== "running" || this.#running.has(task.id)) continue;
      this.#afterAttempt(runId, task, {
        status: "retry",
        reason: "the attempt was interrupted (the process ended)",
      });
    }
  }

  /** pending → ready when its dependencies are done; → blocked when one cannot be. */
  #promote(runId: string): void {
    const { store } = this.#options;
    const tasks = store.tasks(runId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const task of tasks) {
      if (task.state !== "pending" && task.state !== "blocked" && task.state !== "ready") continue;
      const deps = task.spec.dependsOn.map((id) => byId.get(id));
      const stuck = deps.find(
        (d) => d && (d.state === "failed" || d.state === "cancelled" || d.state === "blocked"),
      );
      if (stuck && task.state !== "blocked") {
        this.#move(runId, task.id, "blocked", `depends on "${stuck.id}", which is ${stuck.state}`);
      } else if (!stuck && deps.every((d) => d?.state === "completed") && task.state !== "ready") {
        this.#move(runId, task.id, "ready");
      }
    }
  }

  #startReady(runId: string): void {
    const { store, maxWorkers } = this.#options;
    const tasks = store.tasks(runId);
    const running = tasks.filter((t) => this.#running.has(t.id));
    for (const task of tasks) {
      if (this.#running.size >= maxWorkers) break;
      if (task.state !== "ready") continue;
      if (!task.spec.parallelSafe && this.#running.size > 0) continue;
      if (running.some((r) => !r.spec.parallelSafe)) break;
      if (running.some((r) => touchesOverlap(r.spec.touches, task.spec.touches))) continue;
      this.#start(runId, task);
      running.push(task);
    }
  }

  #start(runId: string, task: TaskRecord): void {
    const { store, runner, attemptTimeoutMs } = this.#options;
    const attempt = task.attempts + 1;
    const started = this.#move(runId, task.id, "running", undefined, { attempts: attempt });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Stop("timeout"));
    }, attemptTimeoutMs);
    store.event(runId, "attempt_started", { attempt }, task.id);
    // Registered before the runner starts, so that it sees itself running.
    const entry: { controller: AbortController; done: Promise<void> } = {
      controller,
      done: Promise.resolve(),
    };
    this.#running.set(task.id, entry);
    entry.done = (async () => {
      let outcome: AttemptOutcome;
      // A runner that does not honour the signal must not hold the run.
      const stopped = new Promise<AttemptOutcome>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "retry", reason: "stopped" });
          },
          { once: true },
        );
      });
      try {
        outcome = await Promise.race([
          runner.run(started, {
            runId,
            attempt,
            signal: controller.signal,
            inputs: this.#inputs(runId, started),
            ...(task.attempts > 0 && task.reason ? { previous: task.reason } : {}),
            assign: (assignment) => {
              store.annotate(runId, task.id, assignment);
            },
            note: (kind, data) => {
              store.event(runId, kind, data, task.id);
            },
          }),
          stopped,
        ]);
      } catch (error) {
        outcome = {
          status: "retry",
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof Stop) {
        outcome =
          reason.why === "cancel"
            ? { status: "failed", reason: "cancelled" }
            : {
                status: "retry",
                reason: `timed out after ${String(Math.round(attemptTimeoutMs / 1000))} s`,
              };
      }
      this.#running.delete(task.id);
      const current = store.task(runId, task.id);
      if (!current) return;
      if (this.#cancelling) {
        this.#move(runId, task.id, "cancelled", "the run was cancelled");
        return;
      }
      this.#afterAttempt(runId, current, outcome);
    })();
  }

  #afterAttempt(runId: string, task: TaskRecord, outcome: AttemptOutcome): void {
    const { store, maxAttempts } = this.#options;
    store.event(runId, "attempt_ended", { attempt: task.attempts, ...outcome }, task.id);
    switch (outcome.status) {
      case "completed":
        this.#move(runId, task.id, "completed", outcome.summary);
        break;
      case "review":
        this.#move(runId, task.id, "review", outcome.reason);
        break;
      case "failed":
        this.#move(runId, task.id, "failed", outcome.reason);
        break;
      case "quota":
        // Not the task's fault: it goes back, without spending an attempt.
        this.#move(runId, task.id, "ready", outcome.reason, {
          attempts: Math.max(0, task.attempts - 1),
        });
        this.#quota = {
          reason: outcome.reason,
          ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}),
        };
        break;
      case "moved":
        // Given to another provider: back, without spending an attempt, and the run goes on.
        this.#move(runId, task.id, "ready", outcome.reason, {
          attempts: Math.max(0, task.attempts - 1),
        });
        break;
      case "retry":
        if (task.attempts < maxAttempts) this.#move(runId, task.id, "ready", outcome.reason);
        else
          this.#move(
            runId,
            task.id,
            "failed",
            `${outcome.reason} (after ${String(task.attempts)} attempts)`,
          );
        break;
    }
  }

  /** What the task's dependencies came to. */
  #inputs(runId: string, task: TaskRecord): TaskInput[] {
    const { store } = this.#options;
    const events = store.events(runId);
    const notes = events.filter((e) => e.kind === "memories");
    return task.spec.dependsOn.flatMap((id) => {
      const done = store.task(runId, id);
      if (!done) return [];
      const memories = notes
        .filter((e) => e.taskId === id)
        .flatMap((e) => (Array.isArray(e.data.ids) ? e.data.ids.map(String) : []));
      // The leader's suggestions when it approved the task (its last review).
      const approved = events
        .filter((e) => e.taskId === id && e.kind === "reviewed" && e.data.leader === true)
        .at(-1);
      const suggestions = Array.isArray(approved?.data.suggestions)
        ? approved.data.suggestions.map(String)
        : [];
      return [
        {
          id,
          title: done.spec.title,
          ...(done.reason ? { summary: done.reason } : {}),
          ...(memories.length > 0 ? { memories: [...new Set(memories)] } : {}),
          ...(suggestions.length > 0 ? { suggestions } : {}),
        },
      ];
    });
  }

  /** The run's state once nothing more can happen now. */
  #settle(runId: string): RunState {
    const { store } = this.#options;
    if (this.#cancelling) {
      for (const task of store.tasks(runId)) {
        if (task.state !== "completed" && task.state !== "cancelled") {
          this.#move(runId, task.id, "cancelled", "the run was cancelled");
        }
      }
      return this.#setRun(runId, "cancelled");
    }
    if (this.#quota) {
      const when = this.#quota.resetsAt
        ? `; it resets at ${this.#quota.resetsAt.toISOString()}`
        : "";
      return this.#setRun(runId, "paused", `the provider's usage limit is reached${when}`);
    }
    if (this.#limited) return this.#setRun(runId, "paused", this.#limited);
    if (this.#pausing) return this.#setRun(runId, "paused", "paused");
    this.#promote(runId);
    // Tasks replaced by a new plan (phase D3) neither failed nor block the run.
    const tasks = store.tasks(runId).filter((t) => !isReplaced(t));
    if (tasks.every((t) => t.state === "completed")) return this.#setRun(runId, "completed");
    if (tasks.some((t) => t.state === "review")) {
      return this.#setRun(runId, "waiting", "tasks wait for a person's review");
    }
    if (tasks.every((t) => FINAL_STATES.has(t.state) || t.state === "blocked")) {
      return this.#setRun(
        runId,
        "failed",
        "some tasks failed, and what depends on them is blocked",
      );
    }
    // Something is ready but was not started (it cannot happen without a pause): keep running.
    return this.#setRun(runId, "running");
  }

  #move(
    runId: string,
    taskId: string,
    to: TaskState,
    reason?: string,
    patch: { attempts?: number } = {},
  ): TaskRecord {
    const record = this.#options.store.transition(runId, taskId, to, {
      ...patch,
      ...(reason === undefined ? {} : { reason }),
    });
    this.#options.onChange?.({
      type: "task",
      task: taskId,
      state: to,
      ...(reason === undefined ? {} : { reason }),
    });
    return record;
  }

  #setRun(runId: string, state: RunState, reason?: string): RunState {
    this.#options.store.setRunState(runId, state);
    if (reason !== undefined) this.#options.store.event(runId, "run_reason", { state, reason });
    this.#options.onChange?.({ type: "run", state, ...(reason === undefined ? {} : { reason }) });
    return state;
  }
}

/**
 * Whether two tasks may change the same files: a path in one equals, or
 * lies under, a path in the other. A glob counts from its fixed part
 * (`src/api/*.ts` → `src/api/`). An empty list touches nothing.
 */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const roots = (paths: readonly string[]) =>
    paths.map((p) => {
      const fixed = p.split(/[*?[{]/, 1)[0] ?? "";
      return normalize(fixed).replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
    });
  const left = roots(a);
  const right = roots(b);
  return left.some((x) =>
    right.some(
      (y) =>
        x === y ||
        x === "." ||
        y === "." ||
        x === "" ||
        y === "" ||
        x.startsWith(`${y}/`) ||
        y.startsWith(`${x}/`),
    ),
  );
}
