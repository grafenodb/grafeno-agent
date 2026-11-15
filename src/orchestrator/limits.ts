import type { OperationalStore } from "./store.js";

/**
 * Limits for a whole run (phase D2, brief §D.6), on top of the limits per
 * attempt (workers at once, time, tokens, context, retries, the plan's
 * own limits). They count what the run's attempts recorded, across every
 * process that worked on the run, so a resumed run keeps its count. When
 * one is reached, nothing new starts: what runs finishes, the run is
 * paused, and it says which limit and how far. Resuming with a higher
 * limit goes on.
 */
export interface RunLimits {
  /** Input + output tokens, as the providers reported them. */
  readonly tokens?: number;
  /** Milliseconds of work: the attempts' time, added up. */
  readonly workMs?: number;
  /** Attempts that did not complete, the model's doing (not a plan's limit or a move). */
  readonly retries?: number;
}

/** Outcomes that were not the model's doing: they do not count as retries. */
const NOT_THE_MODEL = new Set(["completed", "quota", "moved"]);

/** What the run has used so far, from its attempts. */
export function runUsage(
  store: OperationalStore,
  runId: string,
): { tokens: number; workMs: number; retries: number } {
  let tokens = 0;
  let workMs = 0;
  let retries = 0;
  for (const event of store.events(runId)) {
    if (event.kind !== "attempt_metrics") continue;
    const d = event.data;
    tokens += num(d.inputTokens) + num(d.outputTokens);
    workMs += num(d.ms);
    if (typeof d.outcome === "string" && !NOT_THE_MODEL.has(d.outcome)) retries++;
  }
  return { tokens, workMs, retries };
}

/** The first run-wide limit reached, as a reason for a person; undefined while there is room. */
export function limitReached(
  store: OperationalStore,
  runId: string,
  limits: RunLimits,
): string | undefined {
  const used = runUsage(store, runId);
  const n = (value: number) => value.toLocaleString("en-US");
  if (limits.tokens !== undefined && used.tokens >= limits.tokens) {
    return `the run's token limit is reached: ${n(used.tokens)} of ${n(limits.tokens)} reported tokens (resume with a higher --max-tokens)`;
  }
  if (limits.workMs !== undefined && used.workMs >= limits.workMs) {
    return `the run's work-time limit is reached: ${String(Math.round(used.workMs / 60_000))} of ${String(Math.round(limits.workMs / 60_000))} minutes (resume with a higher --max-work)`;
  }
  if (limits.retries !== undefined && used.retries >= limits.retries) {
    return `the run's retry limit is reached: ${String(used.retries)} of ${String(limits.retries)} failed attempts (resume with a higher --max-retries)`;
  }
  return undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
