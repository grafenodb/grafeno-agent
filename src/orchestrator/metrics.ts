import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  classifyFailure,
  failureClass,
  riskOf,
  techOf,
  type FailureClass,
  type Fault,
} from "./capability.js";
import { SqliteStore, type OperationalStore } from "./store.js";

/**
 * Phase C's metrics (brief §C.1): every attempt of every run, across all the
 * user's projects, in one store in the agent's data folder, and each task's
 * outcome. Only numbers, ids and categories: no prompts, no outputs, no
 * file contents, no secrets. It is filled from a run's own events, so a
 * run already recorded can be imported again without counting twice.
 */

/** One attempt, as phase C learns from it. */
export interface AttemptRecord {
  readonly run: string;
  readonly task: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
  readonly project: string;
  readonly at: string;
  readonly kind: string;
  readonly complexity: number;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly tier: string;
  readonly ms: number;
  readonly rounds: number;
  readonly renewals: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly contextPeak: number;
  readonly window: number;
  readonly windowEstimated: boolean;
  /** The plan's fullest limit when the attempt started, from 0 to 1, when the provider said. */
  readonly quotaUsed?: number;
  /** The share of that window the attempt itself spent, from 0 to 1, when it could be measured. */
  readonly quotaShare?: number;
  readonly outcome: string;
  /** Why it did not complete, as a category (`usage_limit`, `timeout`, `checks`…), never text. */
  readonly failure?: string;
  /** Tried on purpose to learn (phase C exploration). */
  readonly explored: boolean;
  /** Whether the attempt's work passed its checks, run by code; absent when none ran. */
  readonly verified?: boolean;
  /** Whose doing a failure was, decided by code (see `classifyFailure`). */
  readonly fault?: Fault;
  /** What kind of failure it was (see `failureClass`): quota, tools, verification… */
  readonly failureClass?: FailureClass;
  /** Times a person answered a question during the attempt. */
  readonly human?: number;
  /** The task's risk and main technology, decided by code from what it touches. */
  readonly risk?: string;
  readonly tech?: string;
  /** The exact model that answered, when the provider said (to notice a new version). */
  readonly modelVersion?: string;
  /** The arm of the attempt before, when this one was an escalation from it. */
  readonly escalatedFrom?: string;
}

/** What a task came to, over all its attempts. */
export interface TaskOutcome {
  readonly run: string;
  readonly task: string;
  readonly project: string;
  readonly at: string;
  readonly kind: string;
  readonly complexity: number;
  readonly state: string;
  readonly attempts: number;
  /** Checks that failed and were sent back to the worker to fix. */
  readonly checksFailed: number;
  readonly merged: boolean;
  readonly conflict: boolean;
  /** Whether a person was asked to look at it (the review state), and how it ended. */
  readonly review?: "approved" | "rejected" | "waiting";
  /** The run's work failed its checks on the user's branch after the merge. */
  readonly regression?: boolean;
}

/** The provider and model of a label: `codex/gpt-6-luna`, or `haiku` (one provider). */
export function splitModel(label: string, provider?: string): { provider: string; model: string } {
  const slash = label.indexOf("/");
  if (slash > 0) return { provider: label.slice(0, slash), model: label.slice(slash + 1) };
  return { provider: provider ?? "claude-code", model: label };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  run TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
  project TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, complexity INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, tier TEXT NOT NULL,
  ms INTEGER NOT NULL, rounds INTEGER NOT NULL, renewals INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL,
  context_peak INTEGER NOT NULL, window INTEGER NOT NULL, window_estimated INTEGER NOT NULL,
  quota_used REAL, outcome TEXT NOT NULL, failure TEXT, explored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run, task, attempt)
);
CREATE TABLE IF NOT EXISTS outcomes (
  run TEXT NOT NULL, task TEXT NOT NULL, project TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL, complexity INTEGER NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL, checks_failed INTEGER NOT NULL,
  merged INTEGER NOT NULL, conflict INTEGER NOT NULL, review TEXT,
  PRIMARY KEY (run, task)
);
`;

/** Columns added after the first schema: an older file gets them, with its rows kept. */
const MIGRATIONS: readonly (readonly [table: string, column: string, type: string])[] = [
  ["attempts", "quota_share", "REAL"],
  ["attempts", "verified", "INTEGER"],
  ["attempts", "fault", "TEXT"],
  ["attempts", "human", "INTEGER"],
  ["attempts", "risk", "TEXT"],
  ["attempts", "tech", "TEXT"],
  ["attempts", "model_version", "TEXT"],
  ["attempts", "escalated_from", "TEXT"],
  ["attempts", "failure_class", "TEXT"],
  ["outcomes", "regression", "INTEGER"],
];

/** Task states after which nothing more happens to a task. */
const FINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * A run's attempts and task outcomes, read from its events: what the
 * workers measured, and what code observed afterwards of each attempt (its
 * checks, whose fault a failure was, whether a person had to answer).
 */
export function deriveRun(
  store: OperationalStore,
  runId: string,
  project: string,
): { attempts: AttemptRecord[]; outcomes: TaskOutcome[] } {
  const run = store.run(runId);
  if (!run) return { attempts: [], outcomes: [] };
  const events = store.events(runId);
  const specs = new Map(run.plan.tasks.map((t) => [t.id, t]));
  // Attempts without a number (recorded before phase C) are numbered in order.
  const seen = new Map<string, number>();
  const attempts: AttemptRecord[] = [];
  /** The latest attempt of each task, for what is observed after its metrics. */
  const latest = new Map<string, number>();
  const asked = new Map<string, number>();
  const patch = (taskId: string, change: Partial<AttemptRecord>) => {
    const index = latest.get(taskId);
    const known = index === undefined ? undefined : attempts[index];
    if (index !== undefined && known) attempts[index] = { ...known, ...change };
  };
  for (const event of events) {
    const taskId = event.taskId;
    if (taskId === undefined) continue;
    const d = event.data;
    switch (event.kind) {
      case "attempt_started":
        asked.set(taskId, 0);
        break;
      case "question":
        // A person answered (yes or no); "nobody" is a refusal with no one there.
        if (d.answer === true || d.answer === false) {
          asked.set(taskId, (asked.get(taskId) ?? 0) + 1);
          patch(taskId, { human: asked.get(taskId) ?? 0 });
        }
        break;
      case "attempt_metrics": {
        const count = (seen.get(taskId) ?? 0) + 1;
        seen.set(taskId, count);
        const label = str(d.model) ?? "unknown";
        const split = splitModel(label, str(d.provider));
        const spec = specs.get(taskId);
        const failure = str(d.failure);
        const outcome = str(d.outcome) ?? "unknown";
        const effort = str(d.effort);
        const quotaUsed = num(d.quotaUsed);
        const quotaShare = num(d.quotaShare);
        const modelVersion = str(d.modelVersion);
        const escalatedFrom = str(d.escalatedFrom);
        latest.set(taskId, attempts.length);
        attempts.push({
          run: runId,
          task: taskId,
          attempt: num(d.attempt) ?? count,
          project,
          at: event.at,
          kind: str(d.kind) ?? spec?.kind ?? "unknown",
          complexity: num(d.complexity) ?? spec?.complexity ?? 0,
          provider: str(d.provider) ?? split.provider,
          model: str(d.modelId) ?? split.model,
          ...(effort ? { effort } : {}),
          tier: str(d.tier) ?? "unknown",
          ms: num(d.ms) ?? 0,
          rounds: num(d.rounds) ?? 0,
          renewals: num(d.renewals) ?? 0,
          inputTokens: num(d.inputTokens) ?? 0,
          outputTokens: num(d.outputTokens) ?? 0,
          cacheTokens: num(d.cacheTokens) ?? 0,
          contextPeak: num(d.contextPeak) ?? 0,
          window: num(d.window) ?? 0,
          windowEstimated: d.windowEstimated === true,
          ...(quotaUsed === undefined ? {} : { quotaUsed }),
          ...(quotaShare === undefined ? {} : { quotaShare }),
          outcome,
          ...(failure ? { failure } : {}),
          explored: d.explored === true,
          human: asked.get(taskId) ?? 0,
          ...(spec ? { risk: riskOf(spec), tech: techOf(spec.touches) } : {}),
          ...(modelVersion ? { modelVersion } : {}),
          ...(escalatedFrom ? { escalatedFrom } : {}),
          // A failure inside the attempt itself: classified now; its end may say more.
          ...(outcome !== "completed"
            ? silentTimeout(failure, num(d.inputTokens), num(d.outputTokens))
              ? SILENT
              : {
                  fault: classifyFailure(failure, undefined),
                  failureClass: failureClass(failure, undefined),
                }
            : {}),
        });
        break;
      }
      case "verified":
        patch(taskId, { verified: d.ok === true });
        break;
      case "attempt_ended": {
        const index = latest.get(taskId);
        const known = index === undefined ? undefined : attempts[index];
        if (!known || d.status === "completed") break;
        // Not completed: the checks' diagnostic or the error says whose doing it was.
        const category = known.verified === false ? "checks" : known.failure;
        const silent = silentTimeout(category, known.inputTokens, known.outputTokens);
        patch(taskId, {
          ...(silent
            ? SILENT
            : {
                fault: classifyFailure(category, str(d.reason)),
                failureClass: failureClass(category, str(d.reason)),
              }),
          ...(known.failure === undefined && known.verified === false ? { failure: "checks" } : {}),
        });
        break;
      }
    }
  }
  const regression = events.some(
    (e) => e.kind === "delivery" && (e.data.status === "undone" || e.data.status === "kept"),
  );
  const outcomes: TaskOutcome[] = [];
  for (const task of store.tasks(runId)) {
    if (!FINAL.has(task.state)) continue;
    const mine = events.filter((e) => e.taskId === task.id);
    const reviewed = mine.some((e) => e.kind === "task_state" && e.data.to === "review");
    const review = !reviewed
      ? undefined
      : task.state === "completed"
        ? ("approved" as const)
        : task.state === "failed" || task.state === "cancelled"
          ? ("rejected" as const)
          : ("waiting" as const);
    outcomes.push({
      run: runId,
      task: task.id,
      project,
      at: mine.at(-1)?.at ?? task.updated,
      kind: task.spec.kind,
      complexity: task.spec.complexity,
      state: task.state,
      attempts: task.attempts,
      checksFailed: mine.filter((e) => e.kind === "verified" && e.data.ok === false).length,
      merged: mine.some((e) => e.kind === "merged"),
      conflict: mine.some((e) => e.kind === "conflict"),
      ...(review ? { review } : {}),
      ...(regression && task.state === "completed" ? { regression: true } : {}),
    });
  }
  return { attempts, outcomes };
}

export class MetricsStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
    for (const [table, column, type] of MIGRATIONS) {
      const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) {
        this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }

  /**
   * Records a run from its events: each attempt, and each task that reached
   * a final state. Recording a run again replaces its rows: nothing is
   * counted twice.
   */
  recordRun(store: OperationalStore, runId: string, project: string): void {
    const { attempts, outcomes } = deriveRun(store, runId, project);
    const insertAttempt = this.#db.prepare(
      `INSERT OR REPLACE INTO attempts (run, task, attempt, project, at, kind, complexity,
        provider, model, effort, tier, ms, rounds, renewals, input_tokens, output_tokens,
        cache_tokens, context_peak, window, window_estimated, quota_used, outcome, failure,
        explored, quota_share, verified, fault, human, risk, tech, model_version, escalated_from,
        failure_class)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertOutcome = this.#db.prepare(
      `INSERT OR REPLACE INTO outcomes (run, task, project, at, kind, complexity, state, attempts,
        checks_failed, merged, conflict, review, regression) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.#db.exec("BEGIN");
    try {
      for (const a of attempts) {
        insertAttempt.run(
          a.run,
          a.task,
          a.attempt,
          a.project,
          a.at,
          a.kind,
          a.complexity,
          a.provider,
          a.model,
          a.effort ?? null,
          a.tier,
          a.ms,
          a.rounds,
          a.renewals,
          a.inputTokens,
          a.outputTokens,
          a.cacheTokens,
          a.contextPeak,
          a.window,
          a.windowEstimated ? 1 : 0,
          a.quotaUsed ?? null,
          a.outcome,
          a.failure ?? null,
          a.explored ? 1 : 0,
          a.quotaShare ?? null,
          a.verified === undefined ? null : a.verified ? 1 : 0,
          a.fault ?? null,
          a.human ?? null,
          a.risk ?? null,
          a.tech ?? null,
          a.modelVersion ?? null,
          a.escalatedFrom ?? null,
          a.failureClass ?? null,
        );
      }
      for (const o of outcomes) {
        insertOutcome.run(
          o.run,
          o.task,
          o.project,
          o.at,
          o.kind,
          o.complexity,
          o.state,
          o.attempts,
          o.checksFailed,
          o.merged ? 1 : 0,
          o.conflict ? 1 : 0,
          o.review ?? null,
          o.regression ? 1 : 0,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  attempts(): AttemptRecord[] {
    return this.#db
      .prepare("SELECT * FROM attempts ORDER BY at, run, task, attempt")
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        const text = (value: unknown) =>
          typeof value === "string" && value !== "" ? value : undefined;
        const present = (value: unknown) => value !== null && value !== undefined;
        const fault = text(row.fault) as Fault | undefined;
        const risk = text(row.risk);
        const tech = text(row.tech);
        const modelVersion = text(row.model_version);
        const escalatedFrom = text(row.escalated_from);
        return {
          run: String(row.run),
          task: String(row.task),
          attempt: Number(row.attempt),
          project: String(row.project),
          at: String(row.at),
          kind: String(row.kind),
          complexity: Number(row.complexity),
          provider: String(row.provider),
          model: String(row.model),
          ...(row.effort === null ? {} : { effort: row.effort as string }),
          tier: String(row.tier),
          ms: Number(row.ms),
          rounds: Number(row.rounds),
          renewals: Number(row.renewals),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          cacheTokens: Number(row.cache_tokens),
          contextPeak: Number(row.context_peak),
          window: Number(row.window),
          windowEstimated: Number(row.window_estimated) === 1,
          ...(row.quota_used === null ? {} : { quotaUsed: Number(row.quota_used) }),
          ...(present(row.quota_share) ? { quotaShare: Number(row.quota_share) } : {}),
          outcome: String(row.outcome),
          ...(row.failure === null ? {} : { failure: row.failure as string }),
          explored: Number(row.explored) === 1,
          ...(present(row.verified) ? { verified: Number(row.verified) === 1 } : {}),
          ...(fault ? { fault } : {}),
          ...(present(row.human) ? { human: Number(row.human) } : {}),
          ...(risk ? { risk } : {}),
          ...(tech ? { tech } : {}),
          ...(modelVersion ? { modelVersion } : {}),
          ...(escalatedFrom ? { escalatedFrom } : {}),
          ...(present(row.failure_class)
            ? { failureClass: row.failure_class as FailureClass }
            : {}),
        };
      });
  }

  outcomes(): TaskOutcome[] {
    return this.#db
      .prepare("SELECT * FROM outcomes ORDER BY at, run, task")
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          run: String(row.run),
          task: String(row.task),
          project: String(row.project),
          at: String(row.at),
          kind: String(row.kind),
          complexity: Number(row.complexity),
          state: String(row.state),
          attempts: Number(row.attempts),
          checksFailed: Number(row.checks_failed),
          merged: Number(row.merged) === 1,
          conflict: Number(row.conflict) === 1,
          ...(row.review === null
            ? {}
            : { review: row.review as NonNullable<TaskOutcome["review"]> }),
          ...(Number(row.regression ?? 0) === 1 ? { regression: true } : {}),
        };
      });
  }

  close(): void {
    this.#db.close();
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Imports the runs already kept in the data folder (`runs/<project>.db`),
 * so what earlier runs taught counts too. Importing again changes nothing.
 * Returns how many runs were read.
 */
export function importRuns(dataDir: string, metrics: MetricsStore): number {
  const folder = join(dataDir, "runs");
  if (!existsSync(folder)) return 0;
  let count = 0;
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".db"))) {
    const store = new SqliteStore(join(folder, file));
    try {
      for (const run of store.runs()) {
        metrics.recordRun(store, run.id, basename(file, ".db"));
        count++;
      }
    } finally {
      store.close();
    }
  }
  return count;
}

/**
 * A timeout in which no answer at all came back (not a token in or out):
 * the server stalled, or the model never finished its first reply. Code
 * cannot tell which, so it is held against nobody, said as the provider's
 * side.
 */
function silentTimeout(
  category: string | undefined,
  input: number | undefined,
  output: number | undefined,
): boolean {
  return category === "timeout" && (input ?? 0) === 0 && (output ?? 0) === 0;
}

const SILENT = { fault: "ambiguous", failureClass: "infrastructure" } as const;
