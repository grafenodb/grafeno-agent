import type { OperationalStore, RunEvent } from "./store.js";
import type { AttemptMetrics } from "./workers.js";

/** One task of a run, by the numbers. */
export interface TaskReport {
  readonly task: string;
  readonly state: string;
  readonly attempts: number;
  readonly models: readonly string[];
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly renewals: number;
  readonly checksFailed: number;
  readonly merged: boolean;
}

/** Attempts grouped by model and effort: the base of phase C's learning. */
export interface ModelReport {
  readonly model: string;
  readonly effort?: string;
  readonly attempts: number;
  readonly completed: number;
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RunReport {
  readonly runId: string;
  readonly state: string;
  readonly tasks: readonly TaskReport[];
  readonly byModel: readonly ModelReport[];
  readonly totals: {
    readonly attempts: number;
    readonly ms: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheTokens: number;
    readonly renewals: number;
    readonly warnings: number;
    readonly questions: number;
  };
  /** Whether any context share came from an assumed window rather than the provider's. */
  readonly estimated: boolean;
  /**
   * Phase C: tasks where the learned router chose differently from the rules,
   * and whether its choice was used (learned mode) or only recorded (shadow).
   */
  readonly learned: { readonly differed: number; readonly applied: number };
}

/**
 * A run by the numbers, from its events: what each task and model spent and
 * how it went. Only numbers, ids and outcomes: no messages, no outputs.
 * Tokens are what the provider reported; context shares from an assumed
 * window are flagged as estimates.
 */
export function runReport(store: OperationalStore, runId: string): RunReport {
  const run = store.run(runId);
  if (!run) throw new Error(`No run ${runId}`);
  const events = store.events(runId);
  const metrics = events
    .filter((e) => e.kind === "attempt_metrics")
    .map((e) => e.data as unknown as AttemptMetrics);
  const count = (kind: string, task?: string) =>
    events.filter((e) => e.kind === kind && (task === undefined || e.taskId === task)).length;

  const tasks: TaskReport[] = store.tasks(runId).map((task) => {
    const mine = metrics.filter((m) => m.task === task.id);
    return {
      task: task.id,
      state: task.state,
      attempts: task.attempts,
      models: [...new Set(mine.map((m) => (m.effort ? `${m.model}·${m.effort}` : m.model)))],
      ms: sum(mine, "ms"),
      inputTokens: sum(mine, "inputTokens"),
      outputTokens: sum(mine, "outputTokens"),
      cacheTokens: sum(mine, "cacheTokens"),
      renewals: sum(mine, "renewals"),
      checksFailed: events.filter(
        (e) => e.kind === "verified" && e.taskId === task.id && e.data.ok === false,
      ).length,
      merged: count("merged", task.id) > 0,
    };
  });

  const groups = new Map<string, AttemptMetrics[]>();
  for (const m of metrics) {
    const key = `${m.model}\u0000${m.effort ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const byModel: ModelReport[] = [...groups.values()].map((group) => {
    const first = group[0] as AttemptMetrics;
    return {
      model: first.model,
      ...(first.effort ? { effort: first.effort } : {}),
      attempts: group.length,
      completed: group.filter((m) => m.outcome === "completed").length,
      ms: sum(group, "ms"),
      inputTokens: sum(group, "inputTokens"),
      outputTokens: sum(group, "outputTokens"),
    };
  });

  return {
    runId,
    state: run.state,
    tasks,
    byModel,
    totals: {
      attempts: metrics.length,
      ms: sum(metrics, "ms"),
      inputTokens: sum(metrics, "inputTokens"),
      outputTokens: sum(metrics, "outputTokens"),
      cacheTokens: sum(metrics, "cacheTokens"),
      renewals: sum(metrics, "renewals"),
      warnings: count("context_warning"),
      questions: count("question"),
    },
    estimated:
      metrics.some((m) => m.windowEstimated && m.contextPeak > 0) || renewedOnEstimate(events),
    learned: {
      differed: events.filter((e) => e.kind === "router_suggestion" && e.data.replace === true)
        .length,
      applied: events.filter((e) => e.kind === "router_suggestion" && e.data.applied === true)
        .length,
    },
  };
}

/** The report as lines for a person. */
export function describeReport(report: RunReport): string[] {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const lines = [
    `Run ${report.runId}: ${report.state}`,
    `${String(report.totals.attempts)} attempts · ${k(report.totals.inputTokens)} in · ${k(report.totals.outputTokens)} out · ${k(report.totals.cacheTokens)} cache · ${(report.totals.ms / 1000).toFixed(0)} s of work`,
  ];
  for (const t of report.tasks) {
    lines.push(
      `  ${t.task.padEnd(20)} ${t.state.padEnd(10)} ${String(t.attempts)} attempt${t.attempts === 1 ? "" : "s"}  ${t.models.join(", ") || "-"}${t.checksFailed ? `  ${String(t.checksFailed)} failed check${t.checksFailed === 1 ? "" : "s"}` : ""}${t.renewals ? `  ${String(t.renewals)} renewal${t.renewals === 1 ? "" : "s"}` : ""}${t.merged ? "  merged" : ""}`,
    );
  }
  if (report.totals.questions)
    lines.push(`${String(report.totals.questions)} questions for a person`);
  if (report.estimated)
    lines.push("Some context shares are estimates (the provider did not say its window).");
  const { differed, applied } = report.learned;
  if (differed > 0) {
    lines.push(
      applied === differed
        ? `The learned router chose ${String(applied)} attempt${applied === 1 ? "" : "s"}' model from recorded runs (grafeno-agent router shows the evidence).`
        : `The learned router would have chosen differently for ${String(differed)} attempt${differed === 1 ? "" : "s"}${applied > 0 ? `, and did for ${String(applied)}` : ", in shadow"} (grafeno-agent router shows the evidence).`,
    );
  }
  return lines;
}

function sum(
  items: readonly AttemptMetrics[],
  key: "ms" | "inputTokens" | "outputTokens" | "cacheTokens" | "renewals",
): number {
  return items.reduce((total, item) => total + (typeof item[key] === "number" ? item[key] : 0), 0);
}

function renewedOnEstimate(events: readonly RunEvent[]): boolean {
  return events.some((e) => e.kind === "context_renewed" && e.data.estimated === true);
}
