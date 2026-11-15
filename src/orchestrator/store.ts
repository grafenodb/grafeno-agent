import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Plan, TaskSpec } from "./plan.js";
import { canTransition, TransitionError, type RunState, type TaskState } from "./states.js";

export interface Run {
  readonly id: string;
  readonly request: string;
  readonly plan: Plan;
  /** An order of the tasks that respects their dependencies. */
  readonly order: readonly string[];
  readonly state: RunState;
  /** The commit the run's work starts from, when the project is a git repository. */
  readonly baseCommit?: string;
  readonly created: string;
  readonly updated: string;
}

export interface TaskRecord {
  readonly runId: string;
  readonly id: string;
  readonly spec: TaskSpec;
  readonly state: TaskState;
  /** Attempts started so far. */
  readonly attempts: number;
  readonly worker?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Why it failed, was blocked or waits for review. */
  readonly reason?: string;
  readonly updated: string;
}

export interface RunEvent {
  readonly seq: number;
  readonly runId: string;
  readonly taskId?: string;
  readonly at: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

/** What may change with a transition. */
export interface TaskPatch {
  readonly attempts?: number;
  readonly worker?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly reason?: string;
}

/**
 * An effect that cannot be undone (a merge, a commit on a shared branch):
 * recorded as started before it runs and done after, by its key, so that
 * after a crash it is checked rather than run twice.
 */
export type EffectStatus = "new" | "started" | "done";

/**
 * The orchestrator's operational state: runs, tasks and their states,
 * events, and irreversible effects. Transactional; it is never memory (that
 * is Grafeno's), and it survives the process.
 */
export interface OperationalStore {
  createRun(request: string, plan: Plan, order: readonly string[], baseCommit?: string): Run;
  run(id: string): Run | undefined;
  runs(): Run[];
  setRunState(id: string, state: RunState): void;
  tasks(runId: string): TaskRecord[];
  task(runId: string, taskId: string): TaskRecord | undefined;
  /** Moves a task, checking the transition and its current state in one transaction. */
  transition(runId: string, taskId: string, to: TaskState, patch?: TaskPatch): TaskRecord;
  event(runId: string, kind: string, data?: Record<string, unknown>, taskId?: string): void;
  /** Records who works on a task now (worker, model, effort), without changing its state. */
  annotate(runId: string, taskId: string, patch: Omit<TaskPatch, "attempts" | "reason">): void;
  events(runId: string, after?: number): RunEvent[];
  /** Records an effect as started; says if it was new, already started (crashed) or done. */
  beginEffect(
    key: string,
    runId: string,
    kind: string,
    data?: Record<string, unknown>,
  ): EffectStatus;
  finishEffect(key: string): void;
  /** The keys of the run's effects started and not finished (a crash, or one in flight). */
  effectsInFlight(runId: string): string[];
  /**
   * Phase D4: the process that runs a run says so, and beats its heart
   * while it does; another process sends it an order (pause, cancel)
   * through here.
   */
  supervise(runId: string, owner: SupervisorClaim): void;
  heartbeat(runId: string, pid: number): void;
  /** The owner stopped running the run (it ended, paused, or was cancelled). */
  unsupervise(runId: string): void;
  supervisor(runId: string): Supervisor | undefined;
  /** Another process asks the owner to pause or cancel. */
  requestControl(runId: string, control: Control): void;
  /** The owner takes the order sent to it, once. */
  takeControl(runId: string): Control | undefined;
  /**
   * Replans part of a run (phase D3), in one transaction: the replaced tasks
   * are cancelled (their history kept, their reason saying they were
   * replaced), the new ones are added, and the run's plan and order become
   * the new ones.
   */
  replan(
    runId: string,
    plan: Plan,
    order: readonly string[],
    added: readonly TaskSpec[],
    replaced: readonly string[],
  ): void;
  close(): void;
}

/** An order to the process that runs a run. */
export type Control = "pause" | "cancel";

/** Who runs a run, as it said when it started. */
export interface SupervisorClaim {
  readonly pid: number;
  /** Started by `--background`: resumed on its own after a reboot. */
  readonly background: boolean;
  /** The project's folder, and the settings, to resume it there. */
  readonly cwd?: string;
  readonly args?: readonly string[];
}

export interface Supervisor extends SupervisorClaim {
  /** Unset when no process runs it now. */
  readonly pid: number;
  readonly running: boolean;
  readonly heartbeat?: string;
  readonly control?: Control;
}

/** The reason a task replaced by a new plan carries: it neither failed nor blocks the run. */
export const REPLACED = "replaced by a new plan";

/** Whether a task was replaced by a new plan (phase D3). */
export function isReplaced(task: { state: string; reason?: string }): boolean {
  return task.state === "cancelled" && (task.reason ?? "").startsWith(REPLACED);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  plan TEXT NOT NULL,
  task_order TEXT NOT NULL,
  state TEXT NOT NULL,
  base_commit TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  spec TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  worker TEXT,
  model TEXT,
  effort TEXT,
  reason TEXT,
  updated TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, seq);
CREATE TABLE IF NOT EXISTS supervisors (
  run_id TEXT PRIMARY KEY,
  pid INTEGER,
  heartbeat TEXT,
  control TEXT,
  background INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  args TEXT
);
CREATE TABLE IF NOT EXISTS effects (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  started TEXT NOT NULL,
  done TEXT
);
`;

interface RunRow {
  id: string;
  request: string;
  plan: string;
  task_order: string;
  state: string;
  base_commit: string | null;
  created: string;
  updated: string;
}

interface TaskRow {
  run_id: string;
  id: string;
  spec: string;
  state: string;
  attempts: number;
  worker: string | null;
  model: string | null;
  effort: string | null;
  reason: string | null;
  updated: string;
}

/** The operational store in SQLite (Node's own `node:sqlite`): one file, or `:memory:`. */
export class SqliteStore implements OperationalStore {
  readonly #db: DatabaseSync;

  constructor(readonly path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(SCHEMA);
  }

  supervise(runId: string, owner: SupervisorClaim): void {
    this.#db
      .prepare(
        `INSERT INTO supervisors (run_id, pid, heartbeat, control, background, cwd, args)
         VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET pid = excluded.pid, heartbeat = excluded.heartbeat,
           background = excluded.background, cwd = COALESCE(excluded.cwd, cwd),
           args = COALESCE(excluded.args, args)`,
      )
      .run(
        runId,
        owner.pid,
        new Date().toISOString(),
        owner.background ? 1 : 0,
        owner.cwd ?? null,
        owner.args ? JSON.stringify(owner.args) : null,
      );
  }

  heartbeat(runId: string, pid: number): void {
    this.#db
      .prepare("UPDATE supervisors SET heartbeat = ? WHERE run_id = ? AND pid = ?")
      .run(new Date().toISOString(), runId, pid);
  }

  unsupervise(runId: string): void {
    this.#db
      .prepare(
        "UPDATE supervisors SET pid = NULL, heartbeat = NULL, control = NULL WHERE run_id = ?",
      )
      .run(runId);
  }

  supervisor(runId: string): Supervisor | undefined {
    const row = this.#db.prepare("SELECT * FROM supervisors WHERE run_id = ?").get(runId) as
      | {
          pid: number | null;
          heartbeat: string | null;
          control: string | null;
          background: number;
          cwd: string | null;
          args: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      pid: row.pid ?? 0,
      running: row.pid !== null,
      background: row.background === 1,
      ...(row.heartbeat ? { heartbeat: row.heartbeat } : {}),
      ...(row.control === "pause" || row.control === "cancel" ? { control: row.control } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.args ? { args: JSON.parse(row.args) as string[] } : {}),
    };
  }

  requestControl(runId: string, control: Control): void {
    this.#db
      .prepare(
        `INSERT INTO supervisors (run_id, control) VALUES (?, ?)
         ON CONFLICT(run_id) DO UPDATE SET control = excluded.control`,
      )
      .run(runId, control);
  }

  takeControl(runId: string): Control | undefined {
    return this.#atomic(() => {
      const row = this.#db
        .prepare("SELECT control FROM supervisors WHERE run_id = ?")
        .get(runId) as { control: string | null } | undefined;
      if (row?.control !== "pause" && row?.control !== "cancel") return undefined;
      this.#db.prepare("UPDATE supervisors SET control = NULL WHERE run_id = ?").run(runId);
      return row.control;
    });
  }

  replan(
    runId: string,
    plan: Plan,
    order: readonly string[],
    added: readonly TaskSpec[],
    replaced: readonly string[],
  ): void {
    this.#atomic(() => {
      const now = new Date().toISOString();
      for (const id of replaced) this.transition(runId, id, "cancelled", { reason: REPLACED });
      const insert = this.#db.prepare(
        "INSERT INTO tasks (run_id, id, spec, state, updated) VALUES (?, ?, ?, 'pending', ?)",
      );
      for (const task of added) insert.run(runId, task.id, JSON.stringify(task), now);
      this.#db
        .prepare("UPDATE runs SET plan = ?, task_order = ?, updated = ? WHERE id = ?")
        .run(JSON.stringify(plan), JSON.stringify(order), now, runId);
      this.#event(runId, "replanned", {
        replaced: [...replaced],
        added: added.map((t) => t.id),
      });
    });
  }

  createRun(request: string, plan: Plan, order: readonly string[], baseCommit?: string): Run {
    const id = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.#atomic(() => {
      this.#db
        .prepare(
          "INSERT INTO runs (id, request, plan, task_order, state, base_commit, created, updated) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
        )
        .run(
          id,
          request,
          JSON.stringify(plan),
          JSON.stringify(order),
          baseCommit ?? null,
          now,
          now,
        );
      const insert = this.#db.prepare(
        "INSERT INTO tasks (run_id, id, spec, state, updated) VALUES (?, ?, ?, 'pending', ?)",
      );
      for (const task of plan.tasks) insert.run(id, task.id, JSON.stringify(task), now);
      this.#event(id, "run_created", { tasks: plan.tasks.length, goal: plan.goal });
    });
    const run = this.run(id);
    if (!run) throw new Error("The run was not stored");
    return run;
  }

  run(id: string): Run | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  runs(): Run[] {
    return (
      this.#db.prepare("SELECT * FROM runs ORDER BY created DESC").all() as unknown as RunRow[]
    ).map(toRun);
  }

  setRunState(id: string, state: RunState): void {
    this.#atomic(() => {
      this.#db
        .prepare("UPDATE runs SET state = ?, updated = ? WHERE id = ?")
        .run(state, new Date().toISOString(), id);
      this.#event(id, "run_state", { state });
    });
  }

  tasks(runId: string): TaskRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM tasks WHERE run_id = ?")
      .all(runId) as unknown as TaskRow[];
    const run = this.run(runId);
    const order = run?.order ?? [];
    return rows.map(toTask).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  task(runId: string, taskId: string): TaskRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE run_id = ? AND id = ?")
      .get(runId, taskId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  transition(runId: string, taskId: string, to: TaskState, patch: TaskPatch = {}): TaskRecord {
    return this.#atomic(() => {
      const current = this.task(runId, taskId);
      if (!current) throw new Error(`No task "${taskId}" in run ${runId}`);
      if (!canTransition(current.state, to)) throw new TransitionError(taskId, current.state, to);
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE tasks SET state = ?, attempts = ?, worker = ?, model = ?, effort = ?, reason = ?, updated = ?
           WHERE run_id = ? AND id = ? AND state = ?`,
        )
        .run(
          to,
          patch.attempts ?? current.attempts,
          patch.worker ?? current.worker ?? null,
          patch.model ?? current.model ?? null,
          patch.effort ?? current.effort ?? null,
          patch.reason ?? null,
          now,
          runId,
          taskId,
          current.state,
        );
      this.#event(runId, "task_state", { from: current.state, to, ...patch }, taskId);
      const after = this.task(runId, taskId);
      if (!after) throw new Error(`Task "${taskId}" disappeared`);
      return after;
    });
  }

  event(runId: string, kind: string, data: Record<string, unknown> = {}, taskId?: string): void {
    this.#event(runId, kind, data, taskId);
  }

  annotate(runId: string, taskId: string, patch: Omit<TaskPatch, "attempts" | "reason">): void {
    this.#atomic(() => {
      const current = this.task(runId, taskId);
      if (!current) throw new Error(`No task "${taskId}" in run ${runId}`);
      this.#db
        .prepare(
          "UPDATE tasks SET worker = ?, model = ?, effort = ?, updated = ? WHERE run_id = ? AND id = ?",
        )
        .run(
          patch.worker ?? current.worker ?? null,
          patch.model ?? current.model ?? null,
          patch.effort ?? current.effort ?? null,
          new Date().toISOString(),
          runId,
          taskId,
        );
      this.#event(runId, "task_assigned", { ...patch }, taskId);
    });
  }

  events(runId: string, after = 0): RunEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, after) as unknown as {
      seq: number;
      run_id: string;
      task_id: string | null;
      at: string;
      kind: string;
      data: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      runId: row.run_id,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      at: row.at,
      kind: row.kind,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }

  beginEffect(
    key: string,
    runId: string,
    kind: string,
    data: Record<string, unknown> = {},
  ): EffectStatus {
    return this.#atomic(() => {
      const row = this.#db.prepare("SELECT status FROM effects WHERE key = ?").get(key) as
        { status: string } | undefined;
      if (row) return row.status === "done" ? "done" : "started";
      this.#db
        .prepare(
          "INSERT INTO effects (key, run_id, kind, status, data, started) VALUES (?, ?, ?, 'started', ?, ?)",
        )
        .run(key, runId, kind, JSON.stringify(data), new Date().toISOString());
      this.#event(runId, "effect_started", { key, kind });
      return "new";
    });
  }

  finishEffect(key: string): void {
    this.#db
      .prepare("UPDATE effects SET status = 'done', done = ? WHERE key = ?")
      .run(new Date().toISOString(), key);
  }

  effectsInFlight(runId: string): string[] {
    const rows = this.#db
      .prepare("SELECT key FROM effects WHERE run_id = ? AND status = 'started'")
      .all(runId) as { key: string }[];
    return rows.map((row) => row.key);
  }

  close(): void {
    this.#db.close();
  }

  #event(runId: string, kind: string, data: Record<string, unknown> = {}, taskId?: string): void {
    this.#db
      .prepare("INSERT INTO events (run_id, task_id, at, kind, data) VALUES (?, ?, ?, ?, ?)")
      .run(runId, taskId ?? null, new Date().toISOString(), kind, JSON.stringify(data));
  }

  /** Runs `work` in one transaction (nested calls join the outer one). */
  #depth = 0;
  #atomic<T>(work: () => T): T {
    if (this.#depth > 0) return work();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth--;
    }
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    request: row.request,
    plan: JSON.parse(row.plan) as Plan,
    order: JSON.parse(row.task_order) as string[],
    state: row.state as RunState,
    ...(row.base_commit === null ? {} : { baseCommit: row.base_commit }),
    created: row.created,
    updated: row.updated,
  };
}

function toTask(row: TaskRow): TaskRecord {
  return {
    runId: row.run_id,
    id: row.id,
    spec: JSON.parse(row.spec) as TaskSpec,
    state: row.state as TaskState,
    attempts: row.attempts,
    ...(row.worker === null ? {} : { worker: row.worker }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    updated: row.updated,
  };
}
