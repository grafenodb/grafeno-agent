import type { TaskSpec, Tier } from "./plan.js";
import type { Catalog } from "./router.js";
import { armKey, bandOf, type ArmStats, type CellStats } from "./stats.js";

/**
 * Phase C's learned router (brief §C.2–C.3), on top of the fixed rules.
 * For every task it says what it would choose and why: a suggestion,
 * recorded in shadow. It replaces the rules' model and effort only under
 * the rule decided with the user (docs/orchestration.md, phase C):
 *
 * 1. both arms have at least 10 tasks in the task's cell;
 * 2. the learned arm is on the provider the rules chose (the user's
 *    affinities and `--provider-for` still decide the provider);
 * 3. it is offered now (the plan's limits were already applied by the
 *    rules);
 * 4. it is as good and cheaper (its clean-success lower bound at least the
 *    rule's rate minus 5 points, at most 70% of the rule's cost), or better
 *    (the rule's arm succeeds cleanly less than 60% of the time and the
 *    learned arm's lower bound is above the rule's upper bound).
 *
 * The planner's explicit recommendation for a task comes first.
 */

/** `rules`: no learning; `shadow`: suggestions recorded, never used; `learned`: used under the rule. */
export const ROUTER_MODES = ["rules", "shadow", "learned"] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];

/** The mode a setting asks for (`AGENT_ROUTER`); default `learned`, as decided. */
export function routerMode(setting: string | undefined): RouterMode {
  const value = (setting ?? "").trim().toLowerCase();
  if (value === "") return "learned";
  if ((ROUTER_MODES as readonly string[]).includes(value)) return value as RouterMode;
  throw new Error(`AGENT_ROUTER must be one of ${ROUTER_MODES.join(", ")}: ${setting ?? ""}`);
}

/** How much worse a cheaper arm's clean success may be, at worst (its lower bound). */
const AS_GOOD_MARGIN = 0.05;
/** A cheaper arm costs at most this share of the rule's arm. */
const CHEAPER = 0.7;
/** Below this clean success, the rule's arm may be replaced by a clearly better one. */
const WEAK = 0.6;

export interface Suggestion {
  /** The cell the task was compared in: `backend · low`. */
  readonly cell: string;
  /** The rules' arm: `claude-code/sonnet · medium`. */
  readonly rule: string;
  /** What the learned router would choose; the rule's own arm when it would keep it. */
  readonly learned: string;
  /** Whether the learned arm differs and meets the rule. */
  readonly replace: boolean;
  /** Why, in a line: the evidence, or what is missing. */
  readonly reason: string;
  /** The learned arm's model and effort, and its tier, when it replaces the rule's. */
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: Tier;
}

export interface RuleChoice {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly tier: Tier;
}

const pct = (r: number) => `${String(Math.round(r * 100))}%`;

/** What the learned router would choose for a task the rules routed. */
export function suggest(
  task: TaskSpec,
  rule: RuleChoice,
  cells: readonly CellStats[],
  catalog: Catalog,
): Suggestion {
  const cellKey = `${task.kind} · ${bandOf(task.complexity)}`;
  const ruleKey = armKey(rule);
  const keep = (reason: string): Suggestion => ({
    cell: cellKey,
    rule: ruleKey,
    learned: ruleKey,
    replace: false,
    reason,
  });
  if (task.recommended) return keep("the planner recommended this task's tier: it comes first");
  const cell = cells.find((c) => c.key === cellKey);
  const ruleArm = cell?.arms.find((a) => a.key === ruleKey);
  if (!cell || !ruleArm) return keep(`no finished ${cellKey} task on ${ruleKey} yet`);
  if (!ruleArm.enough) {
    return keep(`${ruleKey} has ${String(ruleArm.tasks)} ${cellKey} tasks: not enough to compare`);
  }
  const offered = new Set(catalog.models.map((m) => m.id));
  const candidates = cell.arms.filter(
    (a) =>
      a.key !== ruleKey &&
      a.arm.provider === rule.provider &&
      a.enough &&
      offered.has(a.arm.model) &&
      (a.arm.effort === undefined || catalog.efforts.includes(a.arm.effort)),
  );
  if (candidates.length === 0) {
    return keep(`no other ${rule.provider} arm has enough ${cellKey} tasks to compare`);
  }
  const better = candidates
    .filter((a) => ruleArm.clean.rate < WEAK && a.clean.low > ruleArm.clean.high)
    .sort((a, b) => b.clean.low - a.clean.low);
  const cheaper = candidates
    .filter(
      (a) => a.clean.low >= ruleArm.clean.rate - AS_GOOD_MARGIN && a.cost <= ruleArm.cost * CHEAPER,
    )
    .sort((a, b) => a.cost - b.cost);
  const chosen: ArmStats | undefined = better[0] ?? cheaper[0];
  if (!chosen) {
    return keep(
      `${ruleKey} holds: ${pct(ruleArm.clean.rate)} clean over ${String(ruleArm.tasks)} tasks, and no ${rule.provider} arm is as good and cheaper, or clearly better`,
    );
  }
  const why = better[0]
    ? `clearly better: ${pct(chosen.clean.low)}–${pct(chosen.clean.high)} clean against ${pct(ruleArm.clean.rate)} (${pct(ruleArm.clean.low)}–${pct(ruleArm.clean.high)})`
    : `as good and cheaper: ${pct(chosen.clean.low)}+ clean against ${pct(ruleArm.clean.rate)}, ${String(chosen.cost)} tokens against ${String(ruleArm.cost)}`;
  const tier = tierOf(chosen.arm.model, catalog) ?? rule.tier;
  return {
    cell: cellKey,
    rule: ruleKey,
    learned: chosen.key,
    replace: true,
    reason: `${chosen.key} over ${String(chosen.tasks)} ${cellKey} tasks, ${why}`,
    model: chosen.arm.model,
    ...(chosen.arm.effort ? { effort: chosen.arm.effort } : {}),
    tier,
  };
}

function tierOf(model: string, catalog: Catalog): Tier | undefined {
  for (const tier of ["deep", "standard", "light"] as const) {
    if (catalog.tiers[tier].includes(model)) return tier;
  }
  return undefined;
}
