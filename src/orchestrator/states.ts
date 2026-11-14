/** Where a task stands. */
export const TASK_STATES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Every transition a task may make, and nothing else:
 *
 * - pending → ready when its dependencies are completed; → blocked when one failed.
 * - ready → running when a worker takes it.
 * - running → completed when its checks pass; → review when a person must
 *   decide (a conflict, a question); → ready to retry; → failed when no
 *   retries are left.
 * - review → completed (approved), ready (sent back), failed (rejected).
 * - blocked → ready when what blocked it is redone and completed.
 * - failed → ready only when a person retries it.
 * - Any state but completed and cancelled → cancelled.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["completed", "review", "ready", "failed", "cancelled"],
  blocked: ["ready", "cancelled"],
  review: ["completed", "ready", "failed", "cancelled"],
  completed: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States a task does not leave by itself. */
export const FINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled"]);

export class TransitionError extends Error {
  constructor(
    readonly task: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Task "${task}" cannot go from ${from} to ${to}`);
    this.name = "TransitionError";
  }
}

/** Where a run stands. */
export const RUN_STATES = [
  "running",
  "paused",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];
