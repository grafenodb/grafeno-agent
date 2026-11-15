import type { AttemptRecord, TaskOutcome } from "./metrics.js";

/**
 * Phase C's statistics (brief §C.2–C.3): simple and explicit. Tasks are
 * compared only within a cell (their kind and complexity band); within a
 * cell, an arm is a provider, a model and an effort. Rates come with a
 * Wilson 95% interval, so a small sample shows as a wide interval and is
 * never read as a finding.
 */

/** Tasks per arm before its rates are taken as evidence. */
export const MIN_SAMPLE = 10;

export type Band = "low" | "medium" | "high";

/** The complexity band of a task: 1–2 low, 3 medium, 4–5 high. */
export function bandOf(complexity: number): Band {
  if (complexity <= 2) return "low";
  if (complexity === 3) return "medium";
  return "high";
}

/** A rate with its Wilson 95% interval. */
export interface Rate {
  readonly successes: number;
  readonly n: number;
  readonly rate: number;
  readonly low: number;
  readonly high: number;
}

/** The Wilson score interval at 95%: honest for small samples and rates near 0 or 1. */
export function wilson(successes: number, n: number): Rate {
  if (n === 0) return { successes: 0, n: 0, rate: 0, low: 0, high: 1 };
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return {
    successes,
    n,
    rate: p,
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/** A provider, a model and an effort. */
export interface Arm {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export function armKey(arm: Arm): string {
  return `${arm.provider}/${arm.model}${arm.effort ? ` · ${arm.effort}` : ""}`;
}

export interface ArmStats {
  readonly arm: Arm;
  readonly key: string;
  /** Tasks this arm finished (its final attempt), within the cell. */
  readonly tasks: number;
  /** Completed and merged at the first attempt, with no failed check sent back. */
  readonly clean: Rate;
  /** Completed in the end. */
  readonly success: Rate;
  /** Input + output tokens per task, on this arm. */
  readonly cost: number;
  /** Milliseconds of work per task, on this arm. */
  readonly ms: number;
  /** Enough tasks for its rates to count as evidence. */
  readonly enough: boolean;
}

export interface CellStats {
  readonly kind: string;
  readonly band: Band;
  readonly key: string;
  readonly tasks: number;
  /** Most tasks first. */
  readonly arms: readonly ArmStats[];
}

/** Outcomes of attempts that were not the model's doing: they say nothing of the arm. */
const NOT_THE_MODEL = new Set(["quota", "moved"]);

/**
 * The cells and arms of the recorded tasks. A task counts for the arm of
 * its final attempt (the one whose result the task's state shows),
 * leaving out attempts the model was not to blame for (a plan's limit, a
 * move to another provider). Tasks not yet ended are left out.
 */
export function computeStats(
  attempts: readonly AttemptRecord[],
  outcomes: readonly TaskOutcome[],
): CellStats[] {
  const byTask = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const key = `${a.run}\u0000${a.task}`;
    const list = byTask.get(key) ?? [];
    list.push(a);
    byTask.set(key, list);
  }
  interface Acc {
    arm: Arm;
    tasks: number;
    clean: number;
    success: number;
    cost: number;
    ms: number;
  }
  const cells = new Map<string, { kind: string; band: Band; arms: Map<string, Acc> }>();
  for (const outcome of outcomes) {
    const mine = (byTask.get(`${outcome.run}\u0000${outcome.task}`) ?? [])
      .filter((a) => !NOT_THE_MODEL.has(a.outcome))
      .sort((a, b) => a.attempt - b.attempt);
    const last = mine.at(-1);
    if (!last) continue;
    const arm: Arm = {
      provider: last.provider,
      model: last.model,
      ...(last.effort ? { effort: last.effort } : {}),
    };
    const key = armKey(arm);
    const onArm = mine.filter((a) => armKey(a) === key);
    const band = bandOf(outcome.complexity);
    const cellKey = `${outcome.kind} · ${band}`;
    const cell = cells.get(cellKey) ?? { kind: outcome.kind, band, arms: new Map<string, Acc>() };
    cells.set(cellKey, cell);
    const acc = cell.arms.get(key) ?? { arm, tasks: 0, clean: 0, success: 0, cost: 0, ms: 0 };
    cell.arms.set(key, acc);
    const completed = outcome.state === "completed";
    acc.tasks++;
    if (completed) acc.success++;
    if (completed && outcome.merged && outcome.checksFailed === 0 && mine.length === 1) acc.clean++;
    acc.cost += onArm.reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);
    acc.ms += onArm.reduce((n, a) => n + a.ms, 0);
  }
  return [...cells.entries()]
    .map(([key, cell]) => {
      const arms = [...cell.arms.values()]
        .map((acc) => ({
          arm: acc.arm,
          key: armKey(acc.arm),
          tasks: acc.tasks,
          clean: wilson(acc.clean, acc.tasks),
          success: wilson(acc.success, acc.tasks),
          cost: acc.tasks === 0 ? 0 : Math.round(acc.cost / acc.tasks),
          ms: acc.tasks === 0 ? 0 : Math.round(acc.ms / acc.tasks),
          enough: acc.tasks >= MIN_SAMPLE,
        }))
        .sort((a, b) => b.tasks - a.tasks || a.key.localeCompare(b.key));
      return {
        kind: cell.kind,
        band: cell.band,
        key,
        tasks: arms.reduce((n, a) => n + a.tasks, 0),
        arms,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The statistics as lines for a person: each cell, its arms, and whether they are evidence yet. */
export function describeStats(cells: readonly CellStats[], attempts: number): string[] {
  if (cells.length === 0) {
    return ["No finished tasks are recorded yet: the router uses its rules."];
  }
  const pct = (r: number) => `${String(Math.round(r * 100))}%`;
  const lines = [
    `${String(attempts)} attempts, ${String(cells.reduce((n, c) => n + c.tasks, 0))} finished tasks, in ${String(cells.length)} cells (kind · complexity band). An arm needs ${String(MIN_SAMPLE)} tasks in a cell before its rates count.`,
    "Tokens are each provider's own (uncached input + output): compare them within a provider, not across.",
  ];
  for (const cell of cells) {
    lines.push("", `${cell.key}  (${String(cell.tasks)} task${cell.tasks === 1 ? "" : "s"})`);
    for (const arm of cell.arms) {
      const clean = `${pct(arm.clean.rate)} clean [${pct(arm.clean.low)}–${pct(arm.clean.high)}]`;
      const sample = arm.enough ? "" : "  · small sample";
      lines.push(
        `  ${arm.key.padEnd(32)} ${String(arm.tasks).padStart(3)}  ${clean.padEnd(24)} ${pct(arm.success.rate)} done  ${String(arm.cost).padStart(6)} tokens  ${String(Math.round(arm.ms / 1000))} s${sample}`,
      );
    }
  }
  return lines;
}
