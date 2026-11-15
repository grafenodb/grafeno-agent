import { suggest } from "./learned.js";
import type { AttemptRecord, TaskOutcome } from "./metrics.js";
import type { TaskKind, Tier } from "./plan.js";
import type { Catalog } from "./router.js";
import { armKey, bandOf, computeStats } from "./stats.js";

/**
 * Phase C5: the learned policy against the fixed one, on recorded runs.
 *
 * The tasks are replayed in the order they ran. For each, the statistics
 * are computed from the tasks recorded **before** it only, as the router
 * would have had them, and the learned router is asked what it would have
 * chosen instead of the arm the task really ran on. Where it would have
 * chosen differently, the effect is estimated from the two arms' records
 * up to then: the tokens per task it would have saved, and the most clean
 * success it might have cost (the rules' rate minus the learned arm's
 * lower bound).
 *
 * These are estimates: nobody can know how a task would have gone on
 * another model. They say where the learned policy would act, how often,
 * and on what evidence.
 */

export interface Difference {
  readonly run: string;
  readonly task: string;
  readonly cell: string;
  readonly rule: string;
  readonly learned: string;
  readonly reason: string;
  /** Tokens per task the learned arm used less, by the records before this task. */
  readonly tokensSaved: number;
  /** The most clean success it might have cost, from 0 to 1 (0 when it was better). */
  readonly risk: number;
}

export interface Comparison {
  /** Tasks replayed: finished, not explored, with an attempt the model was to blame for. */
  readonly tasks: number;
  readonly differences: readonly Difference[];
  readonly tokensSaved: number;
}

/** Outcomes of attempts that were not the model's doing. */
const NOT_THE_MODEL = new Set(["quota", "moved"]);

export function compareFixedLearned(
  attempts: readonly AttemptRecord[],
  outcomes: readonly TaskOutcome[],
): Comparison {
  const byTask = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const key = `${a.run}\u0000${a.task}`;
    byTask.set(key, [...(byTask.get(key) ?? []), a]);
  }
  // What each provider is known to offer: the models and efforts it ran, by tier.
  const catalogs = new Map<string, Catalog>();
  for (const a of attempts) {
    const known = catalogs.get(a.provider) ?? {
      models: [],
      efforts: [],
      tiers: { deep: [], standard: [], light: [] },
    };
    const tier = (["deep", "standard", "light"] as const).includes(a.tier as Tier)
      ? (a.tier as Tier)
      : undefined;
    catalogs.set(a.provider, {
      models: known.models.some((m) => m.id === a.model)
        ? known.models
        : [...known.models, { id: a.model, name: a.model }],
      efforts:
        a.effort === undefined || known.efforts.includes(a.effort)
          ? known.efforts
          : [...known.efforts, a.effort],
      tiers:
        tier === undefined || known.tiers[tier].includes(a.model)
          ? known.tiers
          : { ...known.tiers, [tier]: [...known.tiers[tier], a.model] },
    });
  }

  const ordered = [...outcomes].sort((x, y) => x.at.localeCompare(y.at));
  const differences: Difference[] = [];
  let tasks = 0;
  for (const [index, outcome] of ordered.entries()) {
    const mine = (byTask.get(`${outcome.run}\u0000${outcome.task}`) ?? [])
      .filter((a) => !NOT_THE_MODEL.has(a.outcome))
      .sort((a, b) => a.attempt - b.attempt);
    const last = mine.at(-1);
    if (!last || last.explored) continue;
    tasks++;
    const before = ordered.slice(0, index);
    const seen = new Set(before.map((o) => `${o.run}\u0000${o.task}`));
    const cells = computeStats(
      attempts.filter((a) => seen.has(`${a.run}\u0000${a.task}`)),
      before,
    );
    const catalog = catalogs.get(last.provider);
    if (!catalog) continue;
    const suggestion = suggest(
      {
        id: outcome.task,
        title: outcome.task,
        description: "",
        kind: outcome.kind as TaskKind,
        dependsOn: [],
        complexity: outcome.complexity,
        capabilities: [],
        touches: [],
        acceptance: [{ check: "files", exist: ["."] }],
        parallelSafe: true,
      },
      {
        provider: last.provider,
        model: last.model,
        tier: (last.tier as Tier | undefined) ?? "standard",
        ...(last.effort ? { effort: last.effort } : {}),
      },
      cells,
      catalog,
    );
    if (!suggestion.replace) continue;
    const cell = cells.find((c) => c.key === `${outcome.kind} · ${bandOf(outcome.complexity)}`);
    const ruleArm = cell?.arms.find((a) => a.key === armKey(last));
    const learnedArm = cell?.arms.find((a) => a.key === suggestion.learned);
    if (!ruleArm || !learnedArm) continue;
    differences.push({
      run: outcome.run,
      task: outcome.task,
      cell: suggestion.cell,
      rule: suggestion.rule,
      learned: suggestion.learned,
      reason: suggestion.reason,
      tokensSaved: ruleArm.cost - learnedArm.cost,
      risk: Math.max(0, ruleArm.clean.rate - learnedArm.clean.low),
    });
  }
  return {
    tasks,
    differences,
    tokensSaved: differences.reduce((n, d) => n + d.tokensSaved, 0),
  };
}

/** The comparison as lines for a person. */
export function describeComparison(comparison: Comparison): string[] {
  const { tasks, differences } = comparison;
  if (tasks === 0) return ["No finished tasks to replay yet."];
  if (differences.length === 0) {
    return [
      `Replayed ${String(tasks)} tasks in the order they ran: the learned router would have kept the rules' choice for every one (not enough comparable tasks yet).`,
    ];
  }
  const lines = [
    `Replayed ${String(tasks)} tasks in the order they ran, each with only what was recorded before it: the learned router would have chosen differently for ${String(differences.length)}.`,
    `Estimated: ${String(comparison.tokensSaved)} tokens saved in all; the most clean success put at risk on one task: ${String(Math.round(Math.max(...differences.map((d) => d.risk)) * 100))} points. These are estimates from each arm's records, not outcomes.`,
  ];
  const byCell = new Map<string, Difference[]>();
  for (const d of differences)
    byCell.set(`${d.cell}: ${d.rule} → ${d.learned}`, [
      ...(byCell.get(`${d.cell}: ${d.rule} → ${d.learned}`) ?? []),
      d,
    ]);
  for (const [key, list] of byCell) {
    const last = list.at(-1);
    lines.push(`  ${key}  ×${String(list.length)}${last ? `  (${last.reason})` : ""}`);
  }
  return lines;
}
