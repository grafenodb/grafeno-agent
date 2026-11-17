import { NO_MODEL } from "./none.js";
import { ACP_CLI_SPECS, AcpCliProvider } from "./acp-cli.js";
import { API_KEY_SPECS, ApiKeyProvider } from "./api-key.js";
import { ClaudeApiProvider } from "./claude-api.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import {
  canonicalProvider,
  local as localProfile,
  providerEnabled,
  registerProfile,
  unregisterProfile,
  withSwitch,
} from "./profiles.js";
import { LocalProvider, type LocalSettings, type LocalState } from "./local/provider.js";
import {
  LOCAL_KIND_INFO,
  builtInConnections,
  loadLocalConnections,
  localConnectionsFile,
  type LocalConnection,
} from "./local/store.js";
import { CodexProvider } from "./codex.js";
import { GeminiProvider } from "./gemini.js";
import { OpenRouterProvider } from "./openrouter.js";
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

/**
 * The providers the agent knows, by the id `AGENT_PROVIDERS` names them
 * with (or an alias: `claude-code-local` is `claude-code`). Each is behind
 * its switch (PROVIDER_<NAME>_ENABLED), read on every call, then its cache.
 */
export const KNOWN_PROVIDERS: Readonly<Record<string, () => Provider>> = {
  "claude-code": () => withSwitch(withCache(new ClaudeCodeProvider())),
  "claude-api": () => withSwitch(withCache(new ClaudeApiProvider())),
  codex: () => withSwitch(withCache(new CodexProvider())),
  // Vendors' CLIs driven over ACP (Copilot, Qwen Code, Kimi Code, Mistral Vibe).
  ...Object.fromEntries(
    ACP_CLI_SPECS.map((spec) => [spec.id, () => withSwitch(withCache(new AcpCliProvider(spec)))]),
  ),
  gemini: () => withSwitch(withCache(new GeminiProvider())),
  openrouter: () => withSwitch(withCache(new OpenRouterProvider())),
  // Vendors reached with a key (an API, or a coding plan's own key), by one shared adapter.
  ...Object.fromEntries(
    API_KEY_SPECS.map((spec) => [spec.id, () => withSwitch(withCache(new ApiKeyProvider(spec)))]),
  ),
};

/** The connections to the person's own model servers registered now, and each one's state. */
const localIds = new Set<string>();
const localStates = new Map<string, LocalState>();

/** What a local connection knows now (its server's models and their capabilities), once it was made. */
export function localState(id: string): LocalState | undefined {
  return localStates.get(id);
}

/** Whether a provider is one of the person's own model servers (local or self-hosted). */
export function isLocalProvider(id: string): boolean {
  return localIds.has(id);
}

/**
 * Registers the person's model servers (local-connections.json, with the
 * built-in Ollama and LM Studio) as providers, replacing those registered
 * before: called at start, and again when /connect adds or removes one.
 * An id taken by another kind of provider is left out. Returns the ids.
 */
export function registerLocalConnections(
  connections: readonly LocalConnection[] = loadLocalConnections(localConnectionsFile()),
  settings: LocalSettings = {},
): string[] {
  const known = KNOWN_PROVIDERS as Record<string, () => Provider>;
  for (const id of localIds) {
    Reflect.deleteProperty(known, id);
    unregisterProfile(id);
    localStates.delete(id);
  }
  localIds.clear();
  for (const connection of connections) {
    // An id another kind of provider has is left to it.
    const taken = connection.id in known;
    if (taken) continue;
    const info = LOCAL_KIND_INFO[connection.kind];
    if (connection.id !== "ollama" && connection.id !== "lmstudio") {
      registerProfile(
        localProfile(connection.id, connection.kind, info.name, {
          costModel:
            connection.kind === "ollama" || connection.kind === "lmstudio"
              ? "local"
              : "self-hosted",
          docs: info.docs,
          note: `${connection.name} at ${connection.url}.`,
        }),
      );
    }
    known[connection.id] = () => {
      const provider = new LocalProvider(connection, settings);
      localStates.set(connection.id, provider.state);
      return withSwitch(withCache(provider));
    };
    localIds.add(connection.id);
  }
  return [...localIds];
}

/** Environment variables that hold the providers' keys: commands the agent runs never see them. */
export const PROVIDER_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  ...API_KEY_SPECS.flatMap((spec) => spec.keyVariables).filter((v) => v !== "OPENAI_API_KEY"),
] as const;

/**
 * Providers reached with an API key of the user's (not an official CLI on
 * this computer): they may bill per token, so General Auto uses them only
 * when the user includes them (AGENT_AUTO_PROVIDERS).
 */
export const API_KEY_PROVIDERS: readonly string[] = [
  "claude-api",
  "gemini",
  "openrouter",
  ...API_KEY_SPECS.map((spec) => spec.id),
];

/** The setting's word for General Auto: the providers it includes, as one pool. */
export const AUTO = "auto";

/**
 * The providers General Auto may use, in order: those AGENT_AUTO_PROVIDERS
 * names, and none until the user chooses them (in /connect, with space):
 * Auto never picks providers on its own. Throws on an id it does not know.
 */
export function autoMembers(env: Record<string, string | undefined> = process.env): string[] {
  const listed = (env.AGENT_AUTO_PROVIDERS ?? "")
    .split(",")
    .map((id) => canonicalProvider(id))
    .filter(Boolean);
  if (listed.length === 0) return [];
  const unknown = listed.filter((id) => !(id in KNOWN_PROVIDERS));
  if (unknown.length > 0) {
    throw new Error(
      `AGENT_AUTO_PROVIDERS names an unknown provider: ${unknown.join(", ")}. Known: ${Object.keys(KNOWN_PROVIDERS).join(", ")}`,
    );
  }
  return [...new Set(listed)];
}

/** The setting that keeps, for each provider in General Auto, the models it may use. */
export const AUTO_MODELS_SETTING = "AGENT_AUTO_MODELS";

/**
 * For each provider in General Auto, the models the person chose
 * (`AGENT_AUTO_MODELS=codex:gpt-6-astra,gpt-6.1-sol;claude-code:auto`). A
 * provider not named, or named `auto`, uses all its models, chosen by the
 * task and what they cost.
 */
export function autoModels(
  env: Record<string, string | undefined> = process.env,
): Record<string, string[]> {
  const chosen: Record<string, string[]> = {};
  for (const part of (env[AUTO_MODELS_SETTING] ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const id = part.slice(0, at).trim();
    const models = part
      .slice(at + 1)
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "" && m.toLowerCase() !== AUTO);
    if (id !== "" && models.length > 0) chosen[id] = [...new Set(models)];
  }
  return chosen;
}

/** The setting's value for these choices; providers on `auto` are left out. */
export function autoModelsSetting(chosen: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(chosen)
    .filter(([, models]) => models.length > 0)
    .map(([id, models]) => `${id}:${models.join(",")}`)
    .join(";");
}

/**
 * Whether a setting asks for General Auto (`AGENT_PROVIDERS=auto`). An
 * empty setting is Auto too, the default: every installed and signed-in
 * provider, found on its own.
 */
export function isAuto(setting: string | undefined): boolean {
  const value = (setting ?? "").trim().toLowerCase();
  return value === AUTO || value === "";
}

/** The setting that says whether the chat is in Auto or on the provider chosen (/mode). */
export const MODE_SETTING = "AGENT_MODE";

/**
 * Whether the chat is in General Auto: as `AGENT_MODE` says (`auto` or
 * `specific`, set by /mode, and by /connect when a provider is chosen),
 * else as `AGENT_PROVIDERS` said before the mode had its own setting.
 * The mode never changes which providers are chosen: switching back to
 * specific finds the one chosen in /connect again.
 */
export function autoMode(env: Record<string, string | undefined> = process.env): boolean {
  const mode = (env[MODE_SETTING] ?? "").trim().toLowerCase();
  if (mode === "auto") return true;
  if (mode === "specific") return false;
  return isAuto(env.AGENT_PROVIDERS);
}

/**
 * The ids in a setting such as "claude-code,codex"; throws on one it does
 * not know. "auto", or nothing (the default), is General Auto: the
 * providers it includes (`autoMembers`), of which the registry keeps the
 * ready ones.
 */
export function providerIds(
  setting: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (isAuto(setting)) return autoMembers(env);
  // "none" chooses no model for the chat only: the providers after it stay chosen for runs.
  const ids = (setting ?? "")
    .split(",")
    .map((id) => canonicalProvider(id))
    .filter((id) => id !== "" && id !== NO_MODEL);
  const chosen = [...new Set(ids)];
  const unknown = chosen.filter((id) => !(id in KNOWN_PROVIDERS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider ${unknown.join(", ")}. Known: ${Object.keys(KNOWN_PROVIDERS).join(", ")}`,
    );
  }
  return chosen;
}

/**
 * The providers the user chose (`AGENT_PROVIDERS`, default auto: every known one),
 * in their order of preference: the chat uses the first; a run gives each
 * task to one of them.
 */
export function chosenProviders(env: Record<string, string | undefined> = process.env): Provider[] {
  // A provider switched off is left out of the choice (it stays listed in /connect).
  return providerIds(env.AGENT_PROVIDERS, env)
    .filter((id) => providerEnabled(id, env))
    .map((id) => (KNOWN_PROVIDERS[id] as () => Provider)());
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
    const [kind, named] = pair.split("=").map((p) => p.trim());
    const provider = named === undefined ? undefined : canonicalProvider(named);
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
  const chosen = providerIds(env.AGENT_PROVIDERS, env);
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
    const [named, tier] = (target ?? "").split(":").map((p) => p.trim());
    const provider = named === undefined || named === "none" ? named : canonicalProvider(named);
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

// The person's own model servers, from their list (and the built-in Ollama and LM Studio).
try {
  registerLocalConnections();
} catch {
  // An unreadable list: the built-in ones only, at their documented addresses.
  registerLocalConnections(builtInConnections());
}
