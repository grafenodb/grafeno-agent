import { ClaudeCodeProvider } from "./claude-code.js";
import { CodexProvider } from "./codex.js";
import { TIERS, type TaskKind, type Tier } from "../orchestrator/plan.js";
import { DEFAULT_AFFINITY, type Affinity } from "../orchestrator/router.js";
import type { Provider } from "./types.js";
import { join } from "node:path";
import { dataDir } from "../data-dir.js";
import { CachedAuth, ProviderStateCache } from "./cache.js";
import { ComposedProvider } from "./compose.js";

let sharedCache: ProviderStateCache | undefined;

/**
 * What providers answered in the last minute, shared by every provider the
 * agent makes in this process and, through a file in the data folder, by
 * its other processes.
 */
export function providerCache(): ProviderStateCache {
  sharedCache ??= new ProviderStateCache(join(dataDir(), "provider-state.json"));
  return sharedCache;
}

/** A provider whose authentication answers (status, usage) are reused for a minute. */
export function withCache<P extends Provider>(provider: P): P | ComposedProvider {
  return provider instanceof ComposedProvider
    ? provider.withAuth(new CachedAuth(provider.id, provider.parts.auth, providerCache()))
    : provider;
}

/** The providers the agent knows, by the id `AGENT_PROVIDERS` names them with. */
export const KNOWN_PROVIDERS: Readonly<Record<string, () => Provider>> = {
  "claude-code": () => withCache(new ClaudeCodeProvider()),
  codex: () => withCache(new CodexProvider()),
};

/** The setting's word for General Auto: every known provider, as one pool. */
export const AUTO = "auto";

/** Whether a setting asks for General Auto (`AGENT_PROVIDERS=auto`). */
export function isAuto(setting: string | undefined): boolean {
  return (setting ?? "").trim().toLowerCase() === AUTO;
}

/**
 * The ids in a setting such as "claude-code,codex"; throws on one it does
 * not know. "auto" is every known provider (General Auto): the registry
 * then keeps only the ready ones.
 */
export function providerIds(setting: string | undefined): string[] {
  if (isAuto(setting)) return Object.keys(KNOWN_PROVIDERS);
  const ids = (setting ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const chosen = ids.length > 0 ? [...new Set(ids)] : ["claude-code"];
  const unknown = chosen.filter((id) => !(id in KNOWN_PROVIDERS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider ${unknown.join(", ")}. Known: ${Object.keys(KNOWN_PROVIDERS).join(", ")}`,
    );
  }
  return chosen;
}

/**
 * The providers the user chose (`AGENT_PROVIDERS`, default claude-code),
 * in their order of preference: the chat uses the first; a run gives each
 * task to one of them.
 */
export function chosenProviders(env: Record<string, string | undefined> = process.env): Provider[] {
  return providerIds(env.AGENT_PROVIDERS).map((id) => (KNOWN_PROVIDERS[id] as () => Provider)());
}

/**
 * A provider for some task kinds, from a setting such as
 * "tests=codex,docs=codex": those tasks go there when it is ready.
 */
export function providerForKinds(
  setting: string | undefined,
  kinds: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (setting ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [kind, provider] = pair.split("=").map((p) => p.trim());
    if (!kind || !provider || !kinds.includes(kind) || !(provider in KNOWN_PROVIDERS)) {
      throw new Error(
        `--provider-for takes kind=provider pairs (kinds: ${kinds.join(", ")}): ${pair}`,
      );
    }
    out[kind] = provider;
  }
  return out;
}

/** Every known provider, the chosen ones first: what `/connect` shows. */
export function allProviders(env: Record<string, string | undefined> = process.env): Provider[] {
  const chosen = providerIds(env.AGENT_PROVIDERS);
  const rest = Object.keys(KNOWN_PROVIDERS).filter((id) => !chosen.includes(id));
  return [...chosen, ...rest].map((id) => (KNOWN_PROVIDERS[id] as () => Provider)());
}

/**
 * The affinities of General Auto: the user's defaults (`DEFAULT_AFFINITY`),
 * changed by a setting such as "review=claude-code:deep,docs=codex:light,
 * frontend=none" (`AGENT_AFFINITY`); "none" removes a kind's affinity.
 */
export function affinityFor(
  setting: string | undefined,
  kinds: readonly string[],
): Partial<Record<TaskKind, Affinity>> {
  const out: Partial<Record<TaskKind, Affinity>> = { ...DEFAULT_AFFINITY };
  for (const pair of (setting ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [kind, target] = pair.split("=").map((p) => p.trim());
    const [provider, tier] = (target ?? "").split(":").map((p) => p.trim());
    const tierOk = tier === undefined || (TIERS as readonly string[]).includes(tier);
    if (!kind || !kinds.includes(kind) || !provider || !tierOk) {
      throw new Error(
        `AGENT_AFFINITY takes kind=provider[:tier] pairs, or kind=none (kinds: ${kinds.join(", ")}; tiers: ${TIERS.join(", ")}): ${pair}`,
      );
    }
    if (provider === "none") {
      Reflect.deleteProperty(out, kind);
      continue;
    }
    if (!(provider in KNOWN_PROVIDERS)) {
      throw new Error(`AGENT_AFFINITY names an unknown provider: ${provider}`);
    }
    out[kind as TaskKind] = { provider, ...(tier ? { tier: tier as Tier } : {}) };
  }
  return out;
}
