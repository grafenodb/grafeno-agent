import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** Task states after which nothing more happens to a task. */
const FINAL = new Set(["completed", "failed", "cancelled"]);

export class MetricsStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
    // Added later: what each attempt spent of its provider's window.
    const columns = this.#db.prepare("PRAGMA table_info(attempts)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "quota_share")) {
      this.#db.exec("ALTER TABLE attempts ADD COLUMN quota_share REAL");
    }
  }

  /**
   * Records a run from its events: each attempt, and each task that reached
   * a final state. Recording a run again replaces its rows: nothing is
   * counted twice.
   */
  recordRun(store: OperationalStore, runId: string, project: string): void {
    const run = store.run(runId);
    if (!run) return;
    const events = store.events(runId);
    const specs = new Map(run.plan.tasks.map((t) => [t.id, t]));
    const insertAttempt = this.#db.prepare(
      `INSERT OR REPLACE INTO attempts (run, task, attempt, project, at, kind, complexity,
        provider, model, effort, tier, ms, rounds, renewals, input_tokens, output_tokens,
        cache_tokens, context_peak, window, window_estimated, quota_used, outcome, failure,
        explored, quota_share) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertOutcome = this.#db.prepare(
      `INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    // Attempts without a number (recorded before phase C) are numbered in order.
    const seen = new Map<string, number>();
    this.#db.exec("BEGIN");
    try {
      for (const event of events) {
        if (event.kind !== "attempt_metrics" || event.taskId === undefined) continue;
        const d = event.data;
        const count = (seen.get(event.taskId) ?? 0) + 1;
        seen.set(event.taskId, count);
        const label = str(d.model) ?? "unknown";
        const split = splitModel(label, str(d.provider));
        insertAttempt.run(
          runId,
          event.taskId,
          num(d.attempt) ?? count,
          project,
          event.at,
          str(d.kind) ?? specs.get(event.taskId)?.kind ?? "unknown",
          num(d.complexity) ?? specs.get(event.taskId)?.complexity ?? 0,
          str(d.provider) ?? split.provider,
          str(d.modelId) ?? split.model,
          str(d.effort) ?? null,
          str(d.tier) ?? "unknown",
          num(d.ms) ?? 0,
          num(d.rounds) ?? 0,
          num(d.renewals) ?? 0,
          num(d.inputTokens) ?? 0,
          num(d.outputTokens) ?? 0,
          num(d.cacheTokens) ?? 0,
          num(d.contextPeak) ?? 0,
          num(d.window) ?? 0,
          d.windowEstimated === true ? 1 : 0,
          num(d.quotaUsed) ?? null,
          str(d.outcome) ?? "unknown",
          str(d.failure) ?? null,
          d.explored === true ? 1 : 0,
          num(d.quotaShare) ?? null,
        );
      }
      for (const task of store.tasks(runId)) {
        if (!FINAL.has(task.state)) continue;
        const mine = events.filter((e) => e.taskId === task.id);
        const reviewed = mine.some((e) => e.kind === "task_state" && e.data.to === "review");
        const review = !reviewed
          ? null
          : task.state === "completed"
            ? "approved"
            : task.state === "failed" || task.state === "cancelled"
              ? "rejected"
              : "waiting";
        const last = mine.at(-1)?.at ?? task.updated;
        insertOutcome.run(
          runId,
          task.id,
          project,
          last,
          task.spec.kind,
          task.spec.complexity,
          task.state,
          task.attempts,
          mine.filter((e) => e.kind === "verified" && e.data.ok === false).length,
          mine.some((e) => e.kind === "merged") ? 1 : 0,
          mine.some((e) => e.kind === "conflict") ? 1 : 0,
          review,
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
          ...(row.quota_share === null || row.quota_share === undefined
            ? {}
            : { quotaShare: Number(row.quota_share) }),
          outcome: String(row.outcome),
          ...(row.failure === null ? {} : { failure: row.failure as string }),
          explored: Number(row.explored) === 1,
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
