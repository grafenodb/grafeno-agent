import type { ModelOption, ProviderUsage } from "../providers/types.js";
import type { Suggestion } from "./learned.js";
import type { Decision } from "./sufficient.js";
import type { TaskKind, TaskSpec, Tier } from "./plan.js";

/** What a task kind gets by default: a tier and an effort. Configuration, not code. */
export interface Profile {
  readonly tier: Tier;
  readonly effort?: string;
}

export const DEFAULT_PROFILES: Readonly<Record<TaskKind, Profile>> = {
  architecture: { tier: "deep", effort: "high" },
  backend: { tier: "deep", effort: "high" },
  debug: { tier: "deep", effort: "high" },
  frontend: { tier: "standard", effort: "medium" },
  refactor: { tier: "standard", effort: "medium" },
  review: { tier: "standard", effort: "medium" },
  tests: { tier: "light", effort: "medium" },
  docs: { tier: "light", effort: "low" },
};

/** What the provider really offers, as it reported it. */
export interface Catalog {
  readonly models: readonly ModelOption[];
  /** Efforts, lowest first; empty when the provider has none. */
  readonly efforts: readonly string[];
  /**
   * For each tier, the provider's models in order of preference (ids or
   * aliases): the provider's own mapping, so that no model is named here.
   */
  readonly tiers: Readonly<Record<Tier, readonly string[]>>;
  /**
   * The person chose these models for General Auto: the router still picks
   * among them by the task, but never swaps them for others by how much of
   * the plan is used or by what they cost.
   */
  readonly pinned?: boolean;
}

/**
 * How eagerly runs spend the plans (`AGENT_ROUTING`):
 * - `economy`: the lightest that can do the task;
 * - `balanced` (the default): the deep tier and high efforts only for hard
 *   tasks (complexity 4–5), a pace that eases off as a plan's window fills,
 *   and models found to spend a large share of a window kept off simple
 *   tasks;
 * - `quality`: the planner's and the profiles' choice, lighter only near
 *   a limit.
 */
export const ROUTING_MODES = ["economy", "balanced", "quality"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** The routing mode a setting asks for; `balanced` when unset or unknown. */
export function routingMode(setting: string | undefined): RoutingMode {
  const value = (setting ?? "").trim().toLowerCase();
  return (ROUTING_MODES as readonly string[]).includes(value) ? (value as RoutingMode) : "balanced";
}

/** What a model and effort were seen to spend: the share of a plan's window per task. */
export interface QuotaCost {
  /** The mean share of the provider's fullest window one task took, from 0 to 1. */
  readonly share: number;
  /** Tasks it was measured on. */
  readonly n: number;
}

/** A task spending at least this share of a window is expensive for a simple task. */
export const EXPENSIVE_SHARE = 0.08;
/** Tasks measured before a model's cost is acted on: a share of a window is a strong signal. */
export const COST_SAMPLE = 2;

export interface RouterOptions {
  readonly profiles?: Partial<Record<TaskKind, Profile>>;
  /** The provider's real usage, when it said. */
  readonly usage?: ProviderUsage;
  /** Above this share of a limit, tasks go one tier lighter. Default: 0.8 in `quality`, else 0.7. */
  readonly lighterAbove?: number;
  /** Above this share, no new task starts: the run waits for the reset. Default: 0.95. */
  readonly holdAbove?: number;
  /** How eagerly the plans are spent. Without it, `quality`: the agent passes `AGENT_ROUTING`. */
  readonly routing?: RoutingMode;
  /** What a model and effort of this provider were seen to spend, when known. */
  readonly costOf?: (model: string, effort: string | undefined) => QuotaCost | undefined;
}

/** Above this share of a limit, one effort lower (not in `quality`). */
const EASE_ABOVE = 0.5;

/** The lighter-tier threshold of a mode. */
function lighterOf(options: RouterOptions): number {
  const eager = options.routing === undefined || options.routing === "quality";
  return options.lighterAbove ?? (eager ? 0.8 : 0.7);
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

/** One effort lower than `effort` that the provider offers, if any. */
function lowerEffort(effort: string | undefined, efforts: readonly string[]): string | undefined {
  if (effort === undefined) return undefined;
  const at = EFFORT_ORDER.indexOf(effort);
  for (let i = at - 1; i >= 0; i--) {
    const lower = EFFORT_ORDER[i];
    if (lower !== undefined && efforts.includes(lower)) return lower;
  }
  return undefined;
}

export type Route =
  | {
      readonly kind: "run";
      readonly tier: Tier;
      /** What the provider is given: an id or alias from its catalog. */
      readonly model: string;
      /** Undefined: the model's own effort. */
      readonly effort?: string;
      /** Why this choice, step by step: kept in the run's events. */
      readonly reasons: readonly string[];
    }
  | { readonly kind: "hold"; readonly reason: string; readonly resets?: string };

/** When a tier has no model, the tiers tried next, in order. */
const FALLBACK: Readonly<Record<Tier, readonly Tier[]>> = {
  deep: ["standard", "light"],
  standard: ["light", "deep"],
  light: ["standard", "deep"],
};

const LIGHTER: Readonly<Record<Tier, Tier>> = {
  deep: "standard",
  standard: "light",
  light: "light",
};

/**
 * Chooses the model and effort for a task, by explicit rules (phase A): the
 * planner's recommendation, else the task kind's profile; a hard task
 * (complexity 4–5) never goes below standard; then what the provider really
 * has, with a fixed fallback order; then its real usage: lighter near the
 * limit, and holding when it is reached. Every step is given as a reason.
 */
export function route(task: TaskSpec, catalog: Catalog, options: RouterOptions = {}): Route {
  const reasons: string[] = [];
  const profile = options.profiles?.[task.kind] ?? DEFAULT_PROFILES[task.kind];
  let tier: Tier = task.recommended?.tier ?? profile.tier;
  reasons.push(
    task.recommended
      ? `the planner recommends ${task.recommended.tier}`
      : `${task.kind} tasks use ${profile.tier}`,
  );
  if (task.complexity >= 4 && tier === "light") {
    tier = "standard";
    reasons.push(`complexity ${String(task.complexity)} needs at least standard`);
  }
  // Without a mode, the rules as they were (the agent passes AGENT_ROUTING, balanced by default).
  const mode = options.routing ?? "quality";
  const hard = task.complexity >= 4;
  if (mode !== "quality" && !hard && tier === "deep") {
    tier = "standard";
    reasons.push(`complexity ${String(task.complexity)}: deep is kept for hard tasks (4–5)`);
  }
  if (mode === "economy" && !hard && tier === "standard") {
    tier = "light";
    reasons.push("economy: the light tier for a task that is not hard");
  }
  let wantedEffort = task.recommended?.effort ?? profile.effort;
  if (mode !== "quality" && !hard && wantedEffort !== undefined) {
    const cap = mode === "economy" ? (task.complexity <= 2 ? "low" : "medium") : "medium";
    if (EFFORT_ORDER.indexOf(wantedEffort) > EFFORT_ORDER.indexOf(cap)) {
      reasons.push(`complexity ${String(task.complexity)}: effort ${cap}, not ${wantedEffort}`);
      wantedEffort = cap;
    }
  }

  const limit = mostUsed(options.usage);
  if (limit && limit.used >= (options.holdAbove ?? 0.95)) {
    return {
      kind: "hold",
      reason: `${limit.label} is ${String(Math.round(limit.used * 100))}% used`,
      ...(limit.resets === undefined ? {} : { resets: limit.resets }),
    };
  }
  // Models the person chose are never swapped by how full the plan is.
  if (limit && limit.used >= lighterOf(options) && tier !== "light" && catalog.pinned !== true) {
    tier = LIGHTER[tier];
    reasons.push(
      `${limit.label} is ${String(Math.round(limit.used * 100))}% used: one tier lighter (${tier})`,
    );
  }

  const available = new Set(catalog.models.map((m) => m.id));
  let model = catalog.tiers[tier].find((id) => available.has(id));
  if (model === undefined) {
    for (const next of FALLBACK[tier]) {
      model = catalog.tiers[next].find((id) => available.has(id));
      if (model !== undefined) {
        reasons.push(`no ${tier} model is available: using ${next}`);
        tier = next;
        break;
      }
    }
  }
  if (model === undefined)
    model = catalog.models.find((m) => m.id !== "default")?.id ?? catalog.models[0]?.id;
  if (model === undefined) return { kind: "hold", reason: "the provider offers no model" };
  reasons.push(`model ${model}`);

  const effort = chooseEffort(wantedEffort, catalog.efforts);
  if (effort.note) reasons.push(effort.note);
  let chosenEffort = effort.value;
  // A pace: as a window fills, one effort lower, before any tier lighter.
  if (mode !== "quality" && limit && limit.used >= EASE_ABOVE && limit.used < lighterOf(options)) {
    const eased = lowerEffort(chosenEffort, catalog.efforts);
    if (eased !== undefined) {
      reasons.push(
        `${limit.label} is ${String(Math.round(limit.used * 100))}% used: effort ${eased}, not ${chosenEffort ?? "the default"}`,
      );
      chosenEffort = eased;
    }
  }
  // What was learned of this model's cost: an expensive one stays off tasks that are not hard.
  if (mode !== "quality" && !hard && catalog.pinned !== true && options.costOf) {
    const cost = options.costOf(model, chosenEffort);
    if (cost && cost.n >= COST_SAMPLE && cost.share >= EXPENSIVE_SHARE) {
      const spent = `${model}${chosenEffort ? ` · ${chosenEffort}` : ""} took ~${String(Math.round(cost.share * 100))}% of a window per task (${String(cost.n)} tasks)`;
      const eased = lowerEffort(chosenEffort, catalog.efforts);
      const easedCost = eased === undefined ? undefined : options.costOf(model, eased);
      if (
        eased !== undefined &&
        !(easedCost && easedCost.n >= COST_SAMPLE && easedCost.share >= EXPENSIVE_SHARE)
      ) {
        reasons.push(
          `${spent}: effort ${eased} for a task of complexity ${String(task.complexity)}`,
        );
        chosenEffort = eased;
      } else if (tier !== "light") {
        const lighterTier = LIGHTER[tier];
        const lighterModel = catalog.tiers[lighterTier].find((id) => available.has(id));
        if (lighterModel !== undefined && lighterModel !== model) {
          reasons.push(
            `${spent}: ${lighterModel} (${lighterTier}) for a task of complexity ${String(task.complexity)}`,
          );
          tier = lighterTier;
          model = lighterModel;
        }
      }
    }
  }
  return {
    kind: "run",
    tier,
    model,
    ...(chosenEffort === undefined ? {} : { effort: chosenEffort }),
    reasons,
  };
}

/** The effort asked for if the provider has it, else the nearest lower one it has. */
function chooseEffort(
  wanted: string | undefined,
  efforts: readonly string[],
): { value?: string; note?: string } {
  if (wanted === undefined || efforts.length === 0) return {};
  if (efforts.includes(wanted)) return { value: wanted, note: `effort ${wanted}` };
  const order = ["low", "medium", "high", "xhigh", "max"];
  const at = order.indexOf(wanted);
  for (let i = at - 1; i >= 0; i--) {
    const lower = order[i];
    if (lower !== undefined && efforts.includes(lower)) {
      return { value: lower, note: `effort ${wanted} is not offered: ${lower}` };
    }
  }
  return { note: `effort ${wanted} is not offered: the model's own` };
}

function mostUsed(usage: ProviderUsage | undefined) {
  if (!usage || usage.limits.length === 0) return undefined;
  return [...usage.limits].sort((a, b) => b.used - a.used)[0];
}

/** One provider the router may choose, as the registry knows it now. */
export interface ProviderEntry {
  readonly id: string;
  readonly catalog: Catalog;
  readonly usage?: ProviderUsage;
  /**
   * How it is paid for: a provider billed per token (allowed by the user)
   * comes after every subscription or free one that can take the task.
   */
  readonly billing?: "subscription" | "free-api" | "metered";
  /** What its models were seen to spend. */
  readonly costOf?: (model: string, effort: string | undefined) => QuotaCost | undefined;
}

export interface AcrossOptions extends RouterOptions {
  /** A provider for some task kinds (when it is ready), before the order of preference. */
  readonly providerFor?: Partial<Record<TaskKind, string>>;
  /**
   * General Auto (B7): every ready provider is one pool. Each task kind goes
   * first to its affinity (a provider, and a tier its role needs); without
   * one, or when that provider has no room, to the provider with the most
   * room, then the one given fewest tasks so far (spreading). Without
   * `auto`, the providers are an order of preference (phase B4).
   */
  readonly auto?: boolean;
  /** For each task kind, its preferred provider and tier (General Auto). */
  readonly affinity?: Partial<Record<TaskKind, Affinity>>;
  /** Tasks given to each provider so far in this run: the spreading tie-break. */
  readonly assigned?: ReadonlyMap<string, number>;
}

/** Where a task kind goes first in General Auto: a provider, and the tier its role needs. */
export interface Affinity {
  readonly provider: string;
  readonly tier?: Tier;
}

/**
 * The user's default affinities (decided 2026-11-15, after their example):
 * planning and architecture on Claude, standard; review, backend and debug
 * on Claude, deep; docs on Codex, light; tests and refactor on Codex,
 * standard; frontend wherever there is most room. A setting changes them
 * (`AGENT_AFFINITY`).
 */
export const DEFAULT_AFFINITY: Readonly<Partial<Record<TaskKind, Affinity>>> = {
  architecture: { provider: "claude-code", tier: "standard" },
  review: { provider: "claude-code", tier: "deep" },
  backend: { provider: "claude-code", tier: "deep" },
  debug: { provider: "claude-code", tier: "deep" },
  docs: { provider: "codex", tier: "light" },
  tests: { provider: "codex", tier: "standard" },
  refactor: { provider: "codex", tier: "standard" },
};

/** A route that also names its provider, and what the learned router said of it (phase C). */
export type ProviderRoute =
  | (Extract<Route, { kind: "run" }> & {
      readonly provider: string;
      readonly suggestion?: Suggestion;
      /** Tried on purpose to learn (phase C4 exploration). */
      readonly explored?: boolean;
      /** The minimum-sufficient router's decision, with its candidates (used, or in shadow). */
      readonly decision?: Decision;
    })
  | Extract<Route, { kind: "hold" }>;

/**
 * Chooses a provider, then its model and effort, for a task. The providers
 * come ready (installed, signed in, not set aside) in the order of
 * preference. A task kind set to one provider goes there. Otherwise the
 * first provider with room takes it. Near a limit, another provider with
 * room is chosen before going a tier lighter; when every one is near its
 * limit, the one with the most room takes it, a tier lighter; when every
 * one has reached it, the task holds until the earliest reset.
 */
export function routeAcross(
  task: TaskSpec,
  providers: readonly ProviderEntry[],
  options: AcrossOptions = {},
): ProviderRoute {
  if (providers.length === 0) return { kind: "hold", reason: "no provider is ready" };
  // Cost first: what bills per token only when no subscription or free quota can take it.
  providers = byCost(providers);
  const lighter = lighterOf(options);
  const hold = options.holdAbove ?? 0.95;
  const used = (p: ProviderEntry) => mostUsed(p.usage)?.used ?? 0;
  if (options.auto === true) return routePool(task, providers, options, used, lighter, hold);
  const wanted = options.providerFor?.[task.kind];
  const ordered = wanted
    ? [...providers.filter((p) => p.id === wanted), ...providers.filter((p) => p.id !== wanted)]
    : [...providers];
  const why = (p: ProviderEntry, first: string) =>
    p.id === wanted ? `${task.kind} tasks go to ${p.id}` : first;

  // A provider with room, in order.
  for (const [index, entry] of ordered.entries()) {
    if (used(entry) >= lighter) continue;
    const chosen = route(task, entry.catalog, { ...options, ...withUsage(entry) });
    if (chosen.kind === "hold") continue;
    const skipped = ordered.slice(0, index).map((p) => `${p.id} is near its limit`);
    return {
      ...chosen,
      provider: entry.id,
      reasons: [
        ...skipped,
        why(entry, index === 0 ? `${entry.id} is the first choice` : `${entry.id} has room`),
        ...chosen.reasons,
      ],
    };
  }
  // Every one near its limit: the one with the most room, a tier lighter (route does it).
  const open = ordered.filter((p) => used(p) < hold).sort((a, b) => used(a) - used(b));
  for (const entry of open) {
    const chosen = route(task, entry.catalog, { ...options, ...withUsage(entry) });
    if (chosen.kind === "hold") continue;
    return {
      ...chosen,
      provider: entry.id,
      reasons: [
        `every provider is near its limit: ${entry.id} has the most room`,
        ...chosen.reasons,
      ],
    };
  }
  // Every one at its limit: wait for the first to reset.
  const limits = ordered.map((p) => ({ p, limit: mostUsed(p.usage) }));
  const first = limits.find((l) => l.limit?.resets !== undefined);
  return {
    kind: "hold",
    reason: `every provider has reached its limit (${limits
      .map((l) => `${l.p.id} ${String(Math.round((l.limit?.used ?? 0) * 100))}%`)
      .join(", ")})`,
    ...(first?.limit?.resets === undefined ? {} : { resets: first.limit.resets }),
  };
}

/** The providers in the same order, those billed per token last. */
export function byCost(providers: readonly ProviderEntry[]): ProviderEntry[] {
  return [
    ...providers.filter((p) => p.billing !== "metered"),
    ...providers.filter((p) => p.billing === "metered"),
  ];
}

/**
 * General Auto: one pool of every ready provider's models. The rule, in
 * order, each step logged:
 *
 * 1. the tier: the planner's recommendation, else the kind's affinity tier,
 *    else its profile; a hard task never below standard;
 * 2. the affinity: an explicit `providerFor`, else the kind's affinity, when
 *    that provider has room;
 * 3. headroom: a provider at its limit (`holdAbove`) is never used, and one
 *    near it (`lighterAbove`) only when none has room;
 * 4. spreading, as the tie-break: the most room, then the fewest tasks given
 *    so far in the run, then the order the providers came in.
 */
function routePool(
  task: TaskSpec,
  providers: readonly ProviderEntry[],
  options: AcrossOptions,
  used: (p: ProviderEntry) => number,
  lighter: number,
  hold: number,
): ProviderRoute {
  const explicit = options.providerFor?.[task.kind];
  const affinity = options.affinity?.[task.kind];
  const wanted = explicit ?? affinity?.provider;
  // The role's tier, for whichever provider takes the task.
  const base = options.profiles?.[task.kind] ?? DEFAULT_PROFILES[task.kind];
  const profiles =
    affinity?.tier === undefined
      ? options.profiles
      : { ...options.profiles, [task.kind]: { ...base, tier: affinity.tier } };
  const assigned = (p: ProviderEntry) => options.assigned?.get(p.id) ?? 0;
  const order = new Map(providers.map((p, index) => [p.id, index]));
  // Cost first (billed per token last), then room, then how many tasks each took.
  const metered = (p: ProviderEntry) => (p.billing === "metered" ? 1 : 0);
  const spread = (a: ProviderEntry, b: ProviderEntry) =>
    metered(a) - metered(b) ||
    used(a) - used(b) ||
    assigned(a) - assigned(b) ||
    (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);

  const withRoom = providers.filter((p) => used(p) < lighter);
  const total = [...(options.assigned?.values() ?? [])].reduce((a, b) => a + b, 0);
  // Not in `quality`: a provider that took most of the run's tasks yields to one with room.
  const overloaded = (p: ProviderEntry) =>
    options.routing !== undefined &&
    options.routing !== "quality" &&
    assigned(p) >= 2 &&
    assigned(p) > total / 2 &&
    withRoom.some((other) => other.id !== p.id);
  const affine = withRoom.find((p) => p.id === wanted);
  const preferred = affine && !overloaded(affine) ? affine : undefined;
  const rest = withRoom.filter((p) => p !== preferred).sort(spread);
  const tryEntries = (entries: readonly ProviderEntry[], first: (p: ProviderEntry) => string) => {
    for (const entry of entries) {
      const chosen = route(task, entry.catalog, {
        ...options,
        ...(profiles ? { profiles } : {}),
        ...withUsage(entry),
      });
      if (chosen.kind === "hold") continue;
      return { ...chosen, provider: entry.id, reasons: [first(entry), ...chosen.reasons] };
    }
    return undefined;
  };

  const notes: string[] = [];
  if (wanted !== undefined && preferred === undefined) {
    notes.push(
      affine
        ? `${wanted} took most of this run's tasks: spreading`
        : providers.some((p) => p.id === wanted)
          ? `${wanted} has no room for ${task.kind} tasks now`
          : `${wanted} is not ready`,
    );
  }
  const chosen =
    (preferred &&
      tryEntries([preferred], (p) =>
        explicit
          ? `${task.kind} tasks go to ${p.id}`
          : `${task.kind} tasks go to ${p.id} (affinity${affinity?.tier ? `, ${affinity.tier}` : ""})`,
      )) ??
    tryEntries(
      rest,
      (p) =>
        `${p.id} has the most room${options.assigned ? ` (${String(assigned(p))} tasks so far)` : ""}`,
    );
  if (chosen) return { ...chosen, reasons: [...notes, ...chosen.reasons] };

  // None has room: the one with the most room under the hard limit, a tier lighter (route does it).
  const open = providers.filter((p) => used(p) < hold).sort(spread);
  const near = tryEntries(
    open,
    (p) => `every provider is near its limit: ${p.id} has the most room`,
  );
  if (near) return near;
  const limits = providers.map((p) => ({ p, limit: mostUsed(p.usage) }));
  const first = limits.find((l) => l.limit?.resets !== undefined);
  return {
    kind: "hold",
    reason: `every provider has reached its limit (${limits
      .map((l) => `${l.p.id} ${String(Math.round((l.limit?.used ?? 0) * 100))}%`)
      .join(", ")})`,
    ...(first?.limit?.resets === undefined ? {} : { resets: first.limit.resets }),
  };
}

function withUsage(entry: ProviderEntry): Pick<RouterOptions, "usage" | "costOf"> {
  return {
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.costOf ? { costOf: entry.costOf } : {}),
  };
}
