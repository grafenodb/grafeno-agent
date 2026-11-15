import type { ModelOption, ProviderUsage } from "../providers/types.js";
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
}

export interface RouterOptions {
  readonly profiles?: Partial<Record<TaskKind, Profile>>;
  /** The provider's real usage, when it said. */
  readonly usage?: ProviderUsage;
  /** Above this share of a limit, tasks go one tier lighter. Default: 0.8. */
  readonly lighterAbove?: number;
  /** Above this share, no new task starts: the run waits for the reset. Default: 0.95. */
  readonly holdAbove?: number;
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

  const limit = mostUsed(options.usage);
  if (limit && limit.used >= (options.holdAbove ?? 0.95)) {
    return {
      kind: "hold",
      reason: `${limit.label} is ${String(Math.round(limit.used * 100))}% used`,
      ...(limit.resets === undefined ? {} : { resets: limit.resets }),
    };
  }
  if (limit && limit.used >= (options.lighterAbove ?? 0.8) && tier !== "light") {
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

  const effort = chooseEffort(task.recommended?.effort ?? profile.effort, catalog.efforts);
  if (effort.note) reasons.push(effort.note);
  return {
    kind: "run",
    tier,
    model,
    ...(effort.value === undefined ? {} : { effort: effort.value }),
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
}

export interface AcrossOptions extends RouterOptions {
  /** A provider for some task kinds (when it is ready), before the order of preference. */
  readonly providerFor?: Partial<Record<TaskKind, string>>;
}

/** A route that also names its provider. */
export type ProviderRoute =
  | (Extract<Route, { kind: "run" }> & { readonly provider: string })
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
  const lighter = options.lighterAbove ?? 0.8;
  const hold = options.holdAbove ?? 0.95;
  const wanted = options.providerFor?.[task.kind];
  const ordered = wanted
    ? [...providers.filter((p) => p.id === wanted), ...providers.filter((p) => p.id !== wanted)]
    : [...providers];
  const used = (p: ProviderEntry) => mostUsed(p.usage)?.used ?? 0;
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

function withUsage(entry: ProviderEntry): { usage?: ProviderUsage } {
  return entry.usage ? { usage: entry.usage } : {};
}
