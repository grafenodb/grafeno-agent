/**
 * Structured checkpoints, in Grafeno's own checkpoint fields.
 *
 * Grafeno's `checkpoint` keeps a task, a summary and four lists (done, next,
 * decisions, files). What else a session needs to go on is packed into them
 * in a fixed form, so Grafeno does not change:
 *
 * - `next[0]` is the next action, and the rest of `next` is what is pending;
 * - the summary ends with one line, `state: {...}`, a JSON object of the
 *   format's version, the task's goal and status, and what is blocked, the
 *   errors still open, the memories worth looking up and the git ref.
 *
 * A checkpoint saved before this format reads as one without a state: its
 * lists as they are, its status unknown ("in_progress").
 */

export const TASK_STATUSES = ["in_progress", "blocked", "paused", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface StructuredCheckpoint {
  /** The checkpoint's own id in Grafeno, once saved. */
  readonly id?: string;
  readonly task: {
    /** The task's name: checkpoints of one task form a chain. */
    readonly id: string;
    readonly goal?: string;
    readonly status: TaskStatus;
    readonly nextAction?: string;
  };
  /** Where it stands, in a few sentences: the present state, not a story. */
  readonly summary: string;
  readonly progress: {
    readonly completed: readonly string[];
    readonly pending: readonly string[];
    readonly blocked: readonly string[];
  };
  readonly decisions: readonly string[];
  readonly files: readonly string[];
  readonly errors: readonly string[];
  /** Ids of memories to look up when they are needed, instead of carrying them. */
  readonly memoryRefs: readonly string[];
  readonly gitRef?: string;
  readonly updatedAt?: Date;
  /** Who saved it. */
  readonly agent?: string;
  /** The checkpoint before it in the chain. */
  readonly previous?: string;
}

/** What a model (or code) gives to save a checkpoint: Grafeno's fields and this format's. */
export interface CheckpointInput {
  readonly task: string;
  readonly summary: string;
  readonly goal?: string;
  readonly status?: string;
  readonly next_action?: string;
  readonly done?: readonly string[];
  readonly next?: readonly string[];
  readonly blocked?: readonly string[];
  readonly decisions?: readonly string[];
  readonly files?: readonly string[];
  readonly errors?: readonly string[];
  readonly memory_refs?: readonly string[];
  readonly git_ref?: string;
}

const STATE_LINE = /(?:^|\n)state: (\{.*\})\s*$/;
const VERSION = 1;

/** The arguments of Grafeno's `checkpoint` for a checkpoint of this format. */
export function packCheckpoint(input: CheckpointInput): Record<string, unknown> {
  const status = isStatus(input.status) ? input.status : "in_progress";
  const nextAction = clean(input.next_action) ?? clean(input.next?.[0]);
  const pending = list(input.next).filter((item, index) =>
    clean(input.next_action) === undefined ? index > 0 : item !== nextAction,
  );
  const state = {
    v: VERSION,
    status,
    ...(clean(input.goal) ? { goal: clean(input.goal) } : {}),
    ...(list(input.blocked).length > 0 ? { blocked: list(input.blocked) } : {}),
    ...(list(input.errors).length > 0 ? { errors: list(input.errors) } : {}),
    ...(list(input.memory_refs).length > 0 ? { memory_refs: unique(list(input.memory_refs)) } : {}),
    ...(clean(input.git_ref) ? { git_ref: clean(input.git_ref) } : {}),
  };
  const summary = withoutState(input.summary).trim();
  return {
    task: input.task,
    summary: `${summary}\nstate: ${JSON.stringify(state)}`,
    done: list(input.done),
    next: nextAction === undefined ? pending : [nextAction, ...pending],
    decisions: list(input.decisions),
    files: unique(list(input.files)),
  };
}

/** A checkpoint of Grafeno (`resume`'s `checkpoint`), read in this format. */
export function readCheckpoint(data: unknown): StructuredCheckpoint | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  const summaryText = typeof raw.summary === "string" ? raw.summary : "";
  const state = readState(summaryText);
  const next = strings(raw.next);
  const task = typeof raw.task === "string" ? raw.task : "";
  const updatedAt = readTime(raw.at);
  if (task === "" && summaryText === "" && next.length === 0) return undefined;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    task: {
      id: task,
      ...(typeof state.goal === "string" ? { goal: state.goal } : {}),
      status: isStatus(state.status) ? state.status : "in_progress",
      ...(next[0] === undefined ? {} : { nextAction: next[0] }),
    },
    summary: withoutState(summaryText).trim(),
    progress: {
      completed: strings(raw.done),
      pending: next.slice(1),
      blocked: strings(state.blocked),
    },
    decisions: strings(raw.decisions),
    files: strings(raw.files),
    errors: strings(state.errors),
    memoryRefs: strings(state.memory_refs),
    ...(typeof state.git_ref === "string" ? { gitRef: state.git_ref } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
    ...(typeof raw.previous === "string" ? { previous: raw.previous } : {}),
  };
}

/** The JSON Schema properties this format adds to Grafeno's `checkpoint` tool. */
export const CHECKPOINT_PROPERTIES = {
  goal: { type: "string", description: "What the task is for, in one line." },
  status: {
    type: "string",
    enum: [...TASK_STATUSES],
    description: "Where the task is: in_progress (default), blocked, paused or done.",
  },
  next_action: {
    type: "string",
    description: "The one next action to take when work resumes. Put the rest in next.",
  },
  blocked: {
    type: "array",
    items: { type: "string" },
    description: "What is blocked, and on what.",
  },
  errors: {
    type: "array",
    items: { type: "string" },
    description: "Errors or failing checks still open.",
  },
  memory_refs: {
    type: "array",
    items: { type: "string" },
    description: "Ids of memories the next session may need to look up.",
  },
} as const;

function readState(summary: string): Record<string, unknown> {
  const match = STATE_LINE.exec(summary);
  if (!match?.[1]) return {};
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withoutState(summary: string): string {
  return summary.replace(STATE_LINE, "");
}

/** Grafeno's times: microseconds since the epoch, or an ISO date. */
function readTime(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e14 ? value / 1000 : value;
    return new Date(ms);
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value);
  return undefined;
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function list(value: readonly string[] | undefined): string[] {
  return strings(value).map((item) => item.trim());
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}
