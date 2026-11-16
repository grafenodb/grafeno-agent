import type { ProviderUsage } from "../providers/types.js";
import { riskOf, type ArmEvidence, type CellEvidence, type Risk } from "./capability.js";
import type { TaskSpec, Tier } from "./plan.js";
import type { Catalog } from "./router.js";
import { bandOf, wilson, type Band } from "./stats.js";

/**
 * Minimum sufficient model routing: for a task, the model and effort with
 * the lowest expected cost of the whole execution (the first attempt, and
 * the retries and escalations its failures would bring) among those likely
 * enough to pass the task's checks. A stronger model is never chosen only
 * because it is more likely to succeed: it must be what the task needs, or
 * cheaper in the end.
 *
 * What each arm can do is a prior by its class (light, standard, deep) and
 * the task's complexity band, corrected by the evidence recorded for that
 * arm on that kind of task. With no evidence the prior decides; evidence
 * moves it in proportion to how much there is, so a few attempts never
 * settle anything, and an arm's popularity counts for nothing: only its
 * rate does.
 */

/** A model and effort of one provider, by increasing capacity. */
export interface Rung {
  readonly model: string;
  readonly effort?: string;
  /** The class the provider's own tiers give the model. */
  readonly tier: Tier;
  /** Its place within its class: 0 for the strongest model of the class. */
  readonly rank: number;
}

const CLASSES: readonly Tier[] = ["light", "standard", "deep"];
/** Models of a class the ladder keeps, strongest first: enough to choose from, few enough to learn. */
const MODELS_PER_CLASS = 2;
const EFFORTS = ["low", "medium", "high"] as const;

/** The class of a model: the tier that lists it earliest (the stronger one on a tie). */
export function classOf(model: string, catalog: Catalog): Tier | undefined {
  let best: { tier: Tier; at: number } | undefined;
  for (const tier of CLASSES) {
    const at = catalog.tiers[tier].indexOf(model);
    if (at >= 0 && (!best || at <= best.at)) best = { tier, at };
  }
  return best?.tier;
}

/** The provider's arms, weakest first: by class, then model, then effort. */
export function ladder(catalog: Catalog): Rung[] {
  const offered = catalog.models.map((m) => m.id).filter((id) => id !== "default");
  const efforts = EFFORTS.filter((e) => catalog.efforts.includes(e));
  const rungs: Rung[] = [];
  for (const tier of CLASSES) {
    const models = offered
      .filter((id) => (classOf(id, catalog) ?? "standard") === tier)
      .sort((a, b) => position(a, tier, catalog) - position(b, tier, catalog))
      .slice(0, MODELS_PER_CLASS);
    // Weakest first within the class too.
    for (const [index, model] of [...models].reverse().entries()) {
      const rank = models.length - 1 - index;
      if (efforts.length === 0) rungs.push({ model, tier, rank });
      else for (const effort of efforts) rungs.push({ model, effort, tier, rank });
    }
  }
  return rungs;
}

function position(model: string, tier: Tier, catalog: Catalog): number {
  const at = catalog.tiers[tier].indexOf(model);
  return at < 0 ? 99 : at;
}

/**
 * What a class of model is expected to do on a complexity band before any
 * evidence: the chance its work passes the checks at the first attempt.
 * These are starting points, stated here so they can be argued with; the
 * recorded attempts replace them as they come.
 */
export const PRIOR: Readonly<Record<Tier, Readonly<Record<Band, number>>>> = {
  light: { low: 0.88, medium: 0.62, high: 0.3 },
  standard: { low: 0.94, medium: 0.82, high: 0.58 },
  deep: { low: 0.97, medium: 0.92, high: 0.8 },
};
const EFFORT_SHIFT: Readonly<Record<string, number>> = { low: -0.06, medium: 0, high: 0.04 };
/** A second model of a class is taken to be a little weaker than the first. */
const RANK_SHIFT = -0.03;
/** How many attempts the prior is worth: evidence outweighs it past this many. */
export const PRIOR_WEIGHT = 4;
/** How much evidence of the same arm on other kinds of task (same band) counts. */
const RELATED_WEIGHT = 0.3;
/** Attempts on the arm and cell from which the evidence, not the prior, is what decides. */
export const ENOUGH = 10;

/** Relative cost of an attempt by class and effort, used only where nothing was measured. */
const CLASS_COST: Readonly<Record<Tier, number>> = { light: 1, standard: 3, deep: 8 };
const EFFORT_COST: Readonly<Record<string, number>> = { low: 0.7, medium: 1, high: 1.6 };

export type RoutingGoal = "economy" | "balanced";

/** The least first-attempt success an arm may have to be tried, and what the whole chain must reach. */
export function thresholds(mode: RoutingGoal, risk: Risk): { floor: number; target: number } {
  const floor =
    mode === "economy"
      ? { low: 0.4, normal: 0.5, high: 0.65 }[risk]
      : { low: 0.5, normal: 0.6, high: 0.75 }[risk];
  return { floor, target: risk === "high" ? 0.95 : 0.9 };
}

/** An earlier attempt of the same task in this run. */
export interface PriorAttempt {
  readonly model: string;
  readonly effort?: string;
  readonly verdict: "passed" | "failed" | "environment" | "ambiguous";
  /** The failure's category (`checks`, `timeout`, `agent`…), when it failed. */
  readonly failure?: string;
  /** The share of the provider's window it took, when measured. */
  readonly share?: number;
}

export interface Candidate {
  readonly arm: string;
  readonly model: string;
  readonly effort?: string;
  readonly tier: Tier;
  /** The estimated chance of passing at the first attempt. */
  readonly p: number;
  readonly prior: number;
  /** Judged attempts of this arm on this kind of task, and their Wilson 95% interval. */
  readonly n: number;
  readonly low: number;
  readonly high: number;
  /** Cost of one attempt, and where the figure comes from. */
  readonly cost: number;
  readonly costSource: "observed" | "estimated" | "unknown";
  /** Expected cost of the whole execution starting here, with what follows a failure. */
  readonly expected: number;
  /** Chance the task ends well within the attempts allowed, starting here. */
  readonly chain: number;
  readonly verdict: "selected" | "discarded";
  readonly why: string;
}

export interface Decision {
  readonly provider: string;
  readonly cell: string;
  readonly risk: Risk;
  readonly mode: RoutingGoal;
  readonly floor: number;
  readonly target: number;
  readonly model: string;
  readonly effort?: string;
  readonly tier: Tier;
  readonly reason: string;
  /** `prior`: no evidence yet; `some`: a little; `evidence`: enough attempts to rest on. */
  readonly confidence: "prior" | "some" | "evidence";
  readonly expectedCost: number;
  readonly costSource: Candidate["costSource"];
  readonly candidates: readonly Candidate[];
  /** What the fixed rules would have chosen, for the record. */
  readonly rule?: string;
  /** Why this attempt is on a stronger arm than the one before, when it is. */
  readonly escalation?: string;
}

export interface SufficientOptions {
  readonly provider: string;
  readonly mode: RoutingGoal;
  readonly evidence: readonly CellEvidence[];
  readonly usage?: ProviderUsage;
  /** This task's earlier attempts in the run, oldest first. */
  readonly history?: readonly PriorAttempt[];
  /** Attempts a task may have in all. Default: 3. */
  readonly maxAttempts?: number;
  /** Above this share of a window, deep models are kept for what needs them. Default: 0.7. */
  readonly lighterAbove?: number;
  readonly rule?: string;
}

const armKey = (provider: string, rung: Pick<Rung, "model" | "effort">) =>
  `${provider}/${rung.model}${rung.effort ? ` · ${rung.effort}` : ""}`;
const pct = (value: number) => `${String(Math.round(value * 100))}%`;

/** The arm a task should run on now: the minimum sufficient one, or an escalation from its last failure. */
export function chooseSufficient(
  task: TaskSpec,
  catalog: Catalog,
  options: SufficientOptions,
): Decision | undefined {
  const rungs = ladder(catalog);
  if (rungs.length === 0) return undefined;
  const band = bandOf(task.complexity);
  const cellKey = `${task.kind} · ${band}`;
  const risk = riskOf(task);
  const { floor, target } = thresholds(options.mode, risk);
  const attempts = options.maxAttempts ?? 3;
  const cell = options.evidence.find((c) => c.key === cellKey);
  const sameBand = options.evidence.filter((c) => c.band === band && c.key !== cellKey);

  // What each rung is expected to do, and to cost.
  const scale = costScale(rungs, options);
  const view = rungs.map((rung) => {
    const key = armKey(options.provider, rung);
    const own = cell?.arms.find((a) => a.key === key);
    const related = sameBand.flatMap((c) => c.arms.filter((a) => a.key === key));
    const prior = clamp(
      PRIOR[rung.tier][band] +
        (rung.effort === undefined ? 0 : (EFFORT_SHIFT[rung.effort] ?? 0)) +
        rung.rank * RANK_SHIFT,
    );
    const relatedWeight = related.reduce((n, a) => n + a.weight, 0) * RELATED_WEIGHT;
    const relatedPassed = related.reduce((n, a) => n + a.weightedPassed, 0) * RELATED_WEIGHT;
    const weight = (own?.weight ?? 0) + relatedWeight;
    const passed = (own?.weightedPassed ?? 0) + relatedPassed;
    const p = (PRIOR_WEIGHT * prior + passed) / (PRIOR_WEIGHT + weight);
    const interval = wilson(own?.passed ?? 0, own?.attempts ?? 0);
    const cost = costOf(rung, own, options, scale);
    return { rung, key, prior, p, n: own?.attempts ?? 0, interval, ...cost, ms: own?.ms ?? 0 };
  });

  // The expected cost and chance of success of the whole execution from each rung:
  // a failure is followed by the next rung up, within the attempts allowed.
  const expected = (index: number, left: number): { cost: number; success: number } => {
    const here = view[index];
    if (!here) return { cost: 0, success: 0 };
    if (left <= 1 || index === view.length - 1) {
      // The last try: repeated on the same arm for what attempts are left.
      let cost = 0;
      let fail = 1;
      for (let i = 0; i < Math.max(1, left); i++) {
        cost += fail * here.cost;
        fail *= 1 - here.p;
      }
      return { cost, success: 1 - fail };
    }
    const next = expected(index + 1, left - 1);
    return {
      cost: here.cost + (1 - here.p) * next.cost,
      success: here.p + (1 - here.p) * next.success,
    };
  };

  const fullest = Math.max(0, ...(options.usage?.limits.map((l) => l.used) ?? [0]));
  const pressed = fullest >= (options.lighterAbove ?? 0.7);
  const history = (options.history ?? []).filter(
    (h) => h.verdict === "failed" || h.verdict === "passed",
  );
  const failed = history.filter((h) => h.verdict === "failed");
  const last = failed.at(-1);
  const left = Math.max(1, attempts - history.length);

  // Where the choice may start: at or above the rung an escalation asks for.
  let from = 0;
  let escalation: string | undefined;
  if (last) {
    const at = view.findIndex(
      (v) => v.rung.model === last.model && (v.rung.effort ?? "") === (last.effort ?? ""),
    );
    const sameArm = failed.filter(
      (h) => h.model === last.model && (h.effort ?? "") === (last.effort ?? ""),
    ).length;
    const lastArm = `${last.model}${last.effort ? ` · ${last.effort}` : ""}`;
    if (at >= 0 && last.failure === "checks" && sameArm === 1) {
      // Failed checks come with a diagnostic the same model can act on, once.
      from = at;
      escalation = `retrying ${lastArm} once with the checks' diagnostic`;
    } else if (at >= 0) {
      from = Math.min(view.length - 1, at + 1);
      escalation =
        from === at
          ? `${lastArm} failed (${last.failure ?? "its checks"}) and is the strongest arm: tried again`
          : `${lastArm} failed (${last.failure ?? "its checks"}${sameArm > 1 ? `, ${String(sameArm)} times` : ""}): escalating`;
    }
  }

  const scored = view.map((v, index) => ({ ...v, index, ...expected(index, left) }));
  const eligible = scored.filter(
    (v) =>
      v.index >= from &&
      v.p >= floor &&
      !(pressed && v.rung.tier === "deep" && risk !== "high" && band !== "high"),
  );
  const reaching = eligible.filter((v) => v.success >= target);
  const retryingSame = escalation?.startsWith("retrying") === true;
  // Above the arm that failed, whatever its floor: an escalation must be able to go on.
  const above = scored.filter(
    (v) =>
      v.index >= from && !(pressed && v.rung.tier === "deep" && risk !== "high" && band !== "high"),
  );
  // The cheapest whole execution that reaches the target; when none does, the
  // one most likely to end well (a last attempt goes to what can pass it).
  const cheapest = (list: typeof scored) =>
    [...list].sort((a, b) => a.cost - b.cost || a.ms - b.ms || a.index - b.index)[0];
  const likeliest = (list: typeof scored) =>
    [...list].sort((a, b) => b.success - a.success || a.cost - b.cost || a.index - b.index)[0];
  const pool = reaching.length > 0 ? reaching : eligible;
  const best =
    // A retry with the checks' diagnostic stays on the arm, while attempts are left after it.
    (retryingSame && left > 1 ? scored.find((v) => v.index === from) : undefined) ??
    cheapest(reaching) ??
    likeliest(last ? above : eligible) ??
    // Nothing is likely enough: the strongest there is, said as such.
    above.at(-1) ??
    scored.at(-1);
  if (!best) return undefined;

  const candidates: Candidate[] = scored.map((v) => {
    const selected = v.index === best.index;
    let why: string;
    if (selected) why = "selected";
    else if (v.index < from) why = "below the arm that already failed on this task";
    else if (v.p < floor)
      why = `first-attempt success ${pct(v.p)} is under the floor ${pct(floor)}`;
    else if (pressed && v.rung.tier === "deep" && risk !== "high" && band !== "high")
      why = `the plan is ${pct(fullest)} used: deep models are kept for what needs them`;
    else if (v.success < target && reaching.length > 0)
      why = `the whole execution would reach ${pct(v.success)}, under ${pct(target)}`;
    else if (v.cost > best.cost) why = `expected cost ${fmt(v.cost)} against ${fmt(best.cost)}`;
    else why = "as cheap, but a stronger arm than needed";
    return {
      arm: v.key,
      model: v.rung.model,
      ...(v.rung.effort ? { effort: v.rung.effort } : {}),
      tier: v.rung.tier,
      p: round(v.p),
      prior: round(v.prior),
      n: v.n,
      low: round(v.interval.low),
      high: round(v.interval.high),
      cost: v.attemptCost,
      costSource: v.costSource,
      expected: v.cost,
      chain: round(v.success),
      verdict: selected ? "selected" : "discarded",
      why,
    };
  });

  const confidence = best.n >= ENOUGH ? "evidence" : best.n > 0 ? "some" : "prior";
  const basis =
    confidence === "prior"
      ? `no ${cellKey} attempt on it yet: the prior for a ${best.rung.tier} model`
      : `${String(best.n)} ${cellKey} attempt${best.n === 1 ? "" : "s"} (${pct(best.interval.low)}–${pct(best.interval.high)} passed)`;
  const reason = escalation
    ? `${escalation}: ${best.key}, ${pct(best.p)} expected to pass (${basis})`
    : pool.length === 0
      ? `no arm reaches ${pct(floor)} for ${cellKey} (risk ${risk}): the strongest, ${best.key}, at ${pct(best.p)} (${basis})`
      : `${best.key} is the cheapest sufficient arm for ${cellKey} (risk ${risk}): ${pct(best.p)} expected to pass at the first attempt (${basis}), ${pct(best.success)} within ${String(left)} attempt${left === 1 ? "" : "s"}, expected cost ${fmt(best.cost)} (${best.costSource})`;

  return {
    provider: options.provider,
    cell: cellKey,
    risk,
    mode: options.mode,
    floor,
    target,
    model: best.rung.model,
    ...(best.rung.effort ? { effort: best.rung.effort } : {}),
    tier: best.rung.tier,
    reason,
    confidence,
    expectedCost: best.cost,
    costSource: best.costSource,
    candidates,
    ...(options.rule ? { rule: options.rule } : {}),
    ...(escalation ? { escalation } : {}),
  };
}

/**
 * How a relative cost becomes a share of a window: the median of what was
 * measured over what was expected, on the arms that were measured.
 */
function costScale(rungs: readonly Rung[], options: SufficientOptions): number | undefined {
  const ratios: number[] = [];
  for (const rung of rungs) {
    const share = measured(rung, options);
    if (share !== undefined && share.share > 0) ratios.push(share.share / relative(rung));
  }
  if (ratios.length === 0) return undefined;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

function relative(rung: Rung): number {
  return CLASS_COST[rung.tier] * (rung.effort === undefined ? 1 : (EFFORT_COST[rung.effort] ?? 1));
}

/** The arm's measured share of a window per attempt, over every kind of task. */
function measured(
  rung: Rung,
  options: SufficientOptions,
): { share: number; samples: number } | undefined {
  const key = armKey(options.provider, rung);
  let total = 0;
  let samples = 0;
  for (const cell of options.evidence) {
    const arm = cell.arms.find((a) => a.key === key);
    if (arm?.share !== undefined) {
      total += arm.share * arm.shareSamples;
      samples += arm.shareSamples;
    }
  }
  return samples > 0 ? { share: total / samples, samples } : undefined;
}

function costOf(
  rung: Rung,
  own: ArmEvidence | undefined,
  options: SufficientOptions,
  scale: number | undefined,
): { attemptCost: number; cost: number; costSource: Candidate["costSource"] } {
  const seen =
    own?.share !== undefined
      ? { share: own.share, samples: own.shareSamples }
      : measured(rung, options);
  if (seen && seen.share > 0) {
    return { attemptCost: seen.share, cost: seen.share, costSource: "observed" };
  }
  if (scale !== undefined) {
    const estimate = relative(rung) * scale;
    return { attemptCost: estimate, cost: estimate, costSource: "estimated" };
  }
  // Nothing measured on this provider: relative units, comparable only among its own arms.
  return { attemptCost: relative(rung), cost: relative(rung), costSource: "unknown" };
}

const clamp = (value: number) => Math.min(0.99, Math.max(0.02, value));
const round = (value: number) => Math.round(value * 1000) / 1000;
const fmt = (value: number) =>
  value < 1 ? `${(value * 100).toFixed(1)}% of a window` : `${value.toFixed(1)} units`;

/** The most of a provider's window one task may spend over all its attempts. */
export const TASK_SHARE_CAP = 0.25;

/** Why a task may not try again: it already spent its share of the plan; undefined while it may. */
export function overBudget(history: readonly PriorAttempt[]): string | undefined {
  const spent = history.reduce((n, h) => n + (h.share ?? 0), 0);
  return spent >= TASK_SHARE_CAP
    ? `its attempts already took ${pct(spent)} of a plan's window, the most one task may (${pct(TASK_SHARE_CAP)}): a person should look at it`
    : undefined;
}

/** A decision as lines for a person. */
export function describeDecision(decision: Decision): string[] {
  const lines = [
    `${decision.cell} · risk ${decision.risk} · ${decision.mode}: ${decision.reason}`,
    ...(decision.rule ? [`  the fixed rules would have chosen ${decision.rule}`] : []),
  ];
  for (const c of decision.candidates) {
    const evidence =
      c.n > 0 ? `${String(c.n)} attempts ${pct(c.low)}–${pct(c.high)}` : "no attempts";
    lines.push(
      `  ${c.verdict === "selected" ? "▸" : " "} ${c.arm.padEnd(34)} ${pct(c.p).padStart(4)} (prior ${pct(c.prior)}, ${evidence})  cost ${fmt(c.expected)} ${c.costSource}  ${c.verdict === "selected" ? "" : c.why}`,
    );
  }
  return lines;
}
