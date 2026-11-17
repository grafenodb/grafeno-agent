/**
 * A reproducible simulation of routing: the fixed rules (as before) against
 * minimum sufficient model routing, on the same fixed set of tasks.
 *
 * It is a simulation, not a measurement of real models: each arm's true
 * chance of passing a task's checks and its true cost are ASSUMED here
 * (`TRUTH`, `trueCost`), hidden from the routers, and different from the
 * new router's priors, so that it has to learn them. What it shows is how
 * each policy behaves given some truth: where it sends the work, what that
 * costs, and what it does to success. Run it with `npm run eval:routing`.
 */
import { pathToFileURL } from "node:url";
import { computeEvidence, judge } from "../../src/orchestrator/capability.js";
import type { AttemptRecord } from "../../src/orchestrator/metrics.js";
import type { TaskKind, TaskSpec, Tier } from "../../src/orchestrator/plan.js";
import {
  route,
  withAdvice,
  type Catalog,
  type RoutingMode,
} from "../../src/orchestrator/router.js";
import { EXPLORE_PER_RUN, EXPLORE_SHARE } from "../../src/orchestrator/learned.js";
import { bandOf, type Band } from "../../src/orchestrator/stats.js";
import {
  chooseSufficient,
  classOf,
  overBudget,
  type PriorAttempt,
  type RoutingGoal,
} from "../../src/orchestrator/sufficient.js";

export const SIM_CATALOG: Catalog = {
  models: [
    { id: "luna", name: "Luna" },
    { id: "terra", name: "Terra" },
    { id: "sol", name: "Sol" },
    { id: "sol61", name: "Sol 6.1" },
    { id: "astra", name: "Astra 6" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: {
    deep: ["astra", "sol61"],
    standard: ["terra", "sol", "sol61"],
    light: ["luna", "terra"],
  },
};

/** The assumed truth: the chance an arm's work passes the checks at one attempt. */
const TRUTH: Readonly<Record<Tier, Readonly<Record<Band, number>>>> = {
  light: { low: 0.93, medium: 0.55, high: 0.15 },
  standard: { low: 0.97, medium: 0.86, high: 0.5 },
  deep: { low: 0.98, medium: 0.95, high: 0.82 },
};
const TRUE_EFFORT: Readonly<Record<string, number>> = { low: -0.08, medium: 0, high: 0.05 };
const TRUE_KIND: Partial<Record<TaskKind, number>> = {
  docs: 0.03,
  debug: -0.08,
  architecture: -0.05,
};
const TRUE_CLASS_COST: Readonly<Record<Tier, number>> = { light: 1, standard: 3.2, deep: 9 };
const TRUE_EFFORT_COST: Readonly<Record<string, number>> = { low: 0.65, medium: 1, high: 1.7 };
/** One relative unit as a share of a window. */
const UNIT = 0.004;
const TRUE_MS: Readonly<Record<Tier, number>> = { light: 40_000, standard: 90_000, deep: 200_000 };
/** Attempts stopped by the environment, whatever the model. */
const ENVIRONMENT_RATE = 0.05;
const MAX_ATTEMPTS = 3;

/** A small seeded generator: the same seed gives the same tasks and outcomes. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const KINDS: readonly (readonly [TaskKind, number])[] = [
  ["backend", 0.3],
  ["frontend", 0.14],
  ["tests", 0.18],
  ["docs", 0.12],
  ["refactor", 0.1],
  ["debug", 0.08],
  ["architecture", 0.08],
];
const COMPLEXITY: readonly (readonly [number, number])[] = [
  [1, 0.15],
  [2, 0.3],
  [3, 0.3],
  [4, 0.18],
  [5, 0.07],
];

function pick<T>(options: readonly (readonly [T, number])[], random: () => number): T {
  let at = random();
  for (const [value, share] of options) {
    at -= share;
    if (at <= 0) return value;
  }
  return (options.at(-1) as readonly [T, number])[0];
}

/** The fixed set of tasks: the same for every policy and every seed of outcomes. */
export function simTasks(count: number, seed = 7): TaskSpec[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_unused, index) => {
    const kind = pick(KINDS, random);
    const complexity = pick(COMPLEXITY, random);
    // As the planner did: a tier and effort recommended for design and code.
    const recommends = random() < 0.7;
    const deepKind = kind === "backend" || kind === "debug" || kind === "architecture";
    return {
      id: `t${String(index)}`,
      title: `Task ${String(index)}`,
      description: "",
      kind,
      dependsOn: [],
      complexity,
      capabilities: ["code"],
      touches: [kind === "docs" ? "docs/guide.md" : `src/module${String(index % 9)}.ts`],
      acceptance: [{ check: "command", run: "npm test" }],
      parallelSafe: true,
      ...(recommends
        ? {
            recommended: deepKind
              ? { tier: "deep" as const, effort: "high" }
              : { tier: "standard" as const, effort: "medium" },
          }
        : {}),
    };
  });
}

function truth(task: TaskSpec, model: string, effort: string | undefined): number {
  const tier = classOf(model, SIM_CATALOG) ?? "standard";
  const p =
    TRUTH[tier][bandOf(task.complexity)] +
    (effort ? (TRUE_EFFORT[effort] ?? 0) : 0) +
    (TRUE_KIND[task.kind] ?? 0);
  return Math.min(0.99, Math.max(0.02, p));
}

function trueCost(model: string, effort: string | undefined, random: () => number): number {
  const tier = classOf(model, SIM_CATALOG) ?? "standard";
  const noise = 0.8 + random() * 0.4;
  return TRUE_CLASS_COST[tier] * (effort ? (TRUE_EFFORT_COST[effort] ?? 1) : 1) * UNIT * noise;
}

export interface SimResult {
  readonly policy: string;
  /** The attempts the run made (for a warm start). */
  readonly records: readonly AttemptRecord[];
  readonly tasks: number;
  /** Tasks that ended with their checks passed, of all. */
  readonly success: number;
  /** Tasks whose first attempt passed. */
  readonly firstAttempt: number;
  /** Attempts per task. */
  readonly attempts: number;
  /** The plan's window spent in all (1 = one whole window). */
  readonly quota: number;
  /** Hours of work in all. */
  readonly hours: number;
  /** First attempts on a deep model: over all tasks, the non-hard ones, and the hard ones. */
  readonly deep: number;
  readonly deepEasy: number;
  readonly deepHard: number;
  /** Attempts held against a model that the environment stopped (should be 0). */
  readonly unfairlyBlamed: number;
  /** First attempts on a light model, over all tasks. */
  readonly light: number;
  /** Moves to a stronger arm per task, and attempts made on purpose to learn. */
  readonly escalations: number;
  readonly explored: number;
}

/**
 * A routing policy, and what it is run with:
 * - `leader`: a leader recommends the strongest model for every task;
 *   `pinned` applies it as the router did before (a pin), `advice` as it
 *   does now (a recommendation, within what the task needs);
 * - `explore`: directed exploration on low-risk tasks, within a budget per
 *   run (each 20 tasks taken as a run);
 * - `warm`: the tasks run twice, and the second pass is measured
 *   (learning accumulated from the first);
 * - `biased`: the history starts with a few failures of the light model on
 *   each kind of task (bad luck early), as a router may have.
 */
export type Policy = {
  readonly name: string;
  readonly leader?: "pinned" | "advice";
  readonly explore?: boolean;
  readonly warm?: boolean;
  readonly biased?: boolean;
} & (
  | { readonly kind: "rules"; readonly routing: RoutingMode }
  | { readonly kind: "sufficient"; readonly mode: RoutingGoal }
);

/** What a leader that always recommends the strongest model says. */
const STRONGEST = { provider: "sim", model: "astra" };

/** Runs one policy over the tasks, in order, learning as it goes when it can. */
export function simulate(tasks: readonly TaskSpec[], policy: Policy, seed = 11): SimResult {
  const random = rng(seed);
  const exploreRandom = rng(seed + 99);
  const records: AttemptRecord[] = policy.biased === true ? biasedHistory(tasks) : [];
  if (policy.warm === true) {
    // A first pass whose attempts are learned from; the second is what is measured.
    const first = simulate(tasks, { ...policy, warm: false }, seed + 1000);
    records.push(...first.records);
  }
  let escalations = 0;
  let explored = 0;
  let light = 0;
  let explorationsThisRun = 0;
  let success = 0;
  let firstAttempt = 0;
  let attempts = 0;
  let quota = 0;
  let ms = 0;
  let deep = 0;
  let deepEasy = 0;
  let deepHard = 0;
  let easy = 0;
  let hard = 0;
  let clock = 0;
  for (const [taskIndex, task_] of tasks.entries()) {
    if (taskIndex % 20 === 0) explorationsThisRun = 0;
    const task: TaskSpec = policy.leader ? { ...task_, assignee: STRONGEST } : task_;
    const isHard = bandOf(task.complexity) === "high";
    if (isHard) hard++;
    else easy++;
    const history: PriorAttempt[] = [];
    let done = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      if (overBudget(history)) break;
      let model: string;
      let effort: string | undefined;
      let tier: Tier;
      let wasExplored = false;
      if (policy.kind === "rules") {
        const ruled = route(task, SIM_CATALOG, { routing: policy.routing });
        if (ruled.kind !== "run") break;
        if (policy.leader === "pinned") {
          // Before: the leader's model, whatever the task needed.
          ({ model } = STRONGEST);
          tier = "deep";
          effort = ruled.effort;
        } else {
          const chosen =
            policy.leader === "advice"
              ? withAdvice(task, { ...ruled, provider: "sim" }, SIM_CATALOG)
              : { ...ruled, provider: "sim" };
          if (chosen.kind !== "run") break;
          ({ model, tier } = chosen);
          effort = chosen.effort;
        }
      } else {
        const decision = chooseSufficient(task, SIM_CATALOG, {
          provider: "sim",
          mode: policy.mode,
          evidence: computeEvidence(records),
          history,
          maxAttempts: MAX_ATTEMPTS,
          ...(policy.leader === "advice" ? { advice: { model: STRONGEST.model } } : {}),
          ...(policy.explore === true
            ? {
                explore: {
                  share: EXPLORE_SHARE,
                  random: exploreRandom,
                  budgetLeft: explorationsThisRun < EXPLORE_PER_RUN,
                },
              }
            : {}),
        });
        if (!decision) break;
        if (policy.leader === "pinned") {
          ({ model } = STRONGEST);
          tier = "deep";
          effort = decision.effort;
        } else {
          ({ model, tier } = decision);
          effort = decision.effort;
        }
        if (decision.explored) {
          wasExplored = true;
          explored++;
          explorationsThisRun++;
        }
        if (decision.escalation?.includes("escalating")) escalations++;
      }
      if (attempt === 1 && tier === "light") light++;
      if (attempt === 1 && tier === "deep") {
        deep++;
        if (isHard) deepHard++;
        else deepEasy++;
      }
      attempts++;
      const cost = trueCost(model, effort, random);
      const took = TRUE_MS[tier] * (0.8 + random() * 0.4);
      quota += cost;
      ms += took;
      const environment = random() < ENVIRONMENT_RATE;
      const passed = !environment && random() < truth(task, model, effort);
      const record: AttemptRecord = {
        run: "sim",
        task: task.id,
        attempt,
        project: "sim",
        at: new Date(clock++ * 1000).toISOString(),
        kind: task.kind,
        complexity: task.complexity,
        provider: "sim",
        model,
        ...(effort ? { effort } : {}),
        tier,
        ms: took,
        rounds: 1,
        renewals: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        contextPeak: 0,
        window: 0,
        windowEstimated: true,
        quotaShare: cost,
        outcome: environment ? "retry" : "completed",
        ...(environment
          ? { failure: "error", fault: "environment" as const }
          : passed
            ? { verified: true }
            : { verified: false, failure: "checks", fault: "model" as const }),
        explored: wasExplored,
      };
      records.push(record);
      history.push({
        model,
        ...(effort ? { effort } : {}),
        verdict: judge(record),
        ...(record.failure ? { failure: record.failure } : {}),
        share: cost,
      });
      if (passed) {
        done = true;
        success++;
        if (attempt === 1) firstAttempt++;
      }
    }
  }
  // An environment failure held against a model would show as a judged failure.
  const unfairlyBlamed = records.filter(
    (r) => r.fault === "environment" && judge(r) === "failed",
  ).length;
  return {
    policy: policy.name,
    records: records.slice(policy.biased === true ? biasedHistory(tasks).length : 0),
    tasks: tasks.length,
    success: success / tasks.length,
    firstAttempt: firstAttempt / tasks.length,
    attempts: attempts / tasks.length,
    quota,
    hours: ms / 3_600_000,
    deep: deep / tasks.length,
    deepEasy: easy === 0 ? 0 : deepEasy / easy,
    deepHard: hard === 0 ? 0 : deepHard / hard,
    unfairlyBlamed,
    light: light / tasks.length,
    escalations: escalations / tasks.length,
    explored,
  };
}

/** A history with bad luck early: the light model failed its checks 3 times at each effort, on each kind of easy task. */
function biasedHistory(tasks: readonly TaskSpec[]): AttemptRecord[] {
  const kinds = [...new Set(tasks.map((t) => t.kind))];
  return kinds.flatMap((kind, k) =>
    [1, 2].flatMap((complexity) =>
      ["low", "medium", "high"].flatMap((effort) =>
        Array.from({ length: 3 }, (_unused, i) => ({
          run: "early",
          task: `early-${kind}-${String(complexity)}-${effort}-${String(i)}`,
          attempt: 1,
          project: "sim",
          at: new Date(k * 100 + i).toISOString(),
          kind,
          complexity,
          provider: "sim",
          model: "luna",
          effort,
          tier: "light",
          ms: 40_000,
          rounds: 1,
          renewals: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          contextPeak: 0,
          window: 0,
          windowEstimated: true,
          quotaShare: UNIT,
          outcome: "retry",
          verified: false,
          failure: "checks",
          fault: "model" as const,
          explored: false,
        })),
      ),
    ),
  );
}

export const POLICIES: readonly Policy[] = [
  { name: "rules · quality", kind: "rules", routing: "quality" },
  { name: "rules · balanced", kind: "rules", routing: "balanced" },
  { name: "sufficient · balanced", kind: "sufficient", mode: "balanced" },
  { name: "sufficient · economy", kind: "sufficient", mode: "economy" },
  // The leader recommends the strongest model for every task.
  { name: "quality · leader, before (pin)", kind: "rules", routing: "quality", leader: "pinned" },
  { name: "quality · leader, now (advice)", kind: "rules", routing: "quality", leader: "advice" },
  {
    name: "balanced · leader, before (pin)",
    kind: "sufficient",
    mode: "balanced",
    leader: "pinned",
  },
  {
    name: "balanced · leader, now (advice)",
    kind: "sufficient",
    mode: "balanced",
    leader: "advice",
  },
  // Learning: exploration, a second pass, and a history with bad luck early.
  { name: "balanced + exploration", kind: "sufficient", mode: "balanced", explore: true },
  { name: "balanced, warm (2nd pass)", kind: "sufficient", mode: "balanced", warm: true },
  {
    name: "balanced + expl., warm",
    kind: "sufficient",
    mode: "balanced",
    explore: true,
    warm: true,
  },
  { name: "balanced, biased history", kind: "sufficient", mode: "balanced", biased: true },
  {
    name: "balanced + expl., biased",
    kind: "sufficient",
    mode: "balanced",
    explore: true,
    biased: true,
  },
];

/** Every policy on the same tasks, averaged over several seeds of outcomes. */
export function compareRouters(
  count = 400,
  seeds: readonly number[] = [11, 23, 37],
  policies: readonly Policy[] = POLICIES,
): SimResult[] {
  const tasks = simTasks(count);
  return policies.map((policy) => {
    const runs = seeds.map((seed) => simulate(tasks, policy, seed));
    const mean = (pickOf: (r: SimResult) => number) =>
      runs.reduce((n, r) => n + pickOf(r), 0) / runs.length;
    return {
      policy: runs[0]?.policy ?? "",
      records: [],
      tasks: count,
      success: mean((r) => r.success),
      firstAttempt: mean((r) => r.firstAttempt),
      attempts: mean((r) => r.attempts),
      quota: mean((r) => r.quota),
      hours: mean((r) => r.hours),
      deep: mean((r) => r.deep),
      deepEasy: mean((r) => r.deepEasy),
      deepHard: mean((r) => r.deepHard),
      unfairlyBlamed: mean((r) => r.unfairlyBlamed),
      light: mean((r) => r.light),
      escalations: mean((r) => r.escalations),
      explored: mean((r) => r.explored),
    };
  });
}

export function describeComparison(results: readonly SimResult[]): string[] {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Simulated: ${String(results[0]?.tasks ?? 0)} fixed tasks, mean of 3 seeds. Assumed truth, not real models.`,
    "",
    "policy                            success  1st try  attempts  windows  hours  light   deep  deep(easy)  deep(hard)  escal.  explored",
  ];
  for (const r of results) {
    lines.push(
      `${r.policy.padEnd(33)} ${pct(r.success).padStart(7)}  ${pct(r.firstAttempt).padStart(7)}  ${r.attempts.toFixed(2).padStart(8)}  ${r.quota.toFixed(2).padStart(7)}  ${r.hours.toFixed(1).padStart(5)}  ${pct(r.light).padStart(5)}  ${pct(r.deep).padStart(5)}  ${pct(r.deepEasy).padStart(10)}  ${pct(r.deepHard).padStart(10)}  ${r.escalations.toFixed(2).padStart(6)}  ${r.explored.toFixed(1).padStart(8)}`,
    );
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of describeComparison(compareRouters())) console.log(line);
}
