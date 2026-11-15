import { ClaudeCodeProvider } from "./claude-code.js";
import { CodexProvider } from "./codex.js";
import type { Provider } from "./types.js";

/** The providers the agent knows, by the id `AGENT_PROVIDERS` names them with. */
export const KNOWN_PROVIDERS: Readonly<Record<string, () => Provider>> = {
  "claude-code": () => new ClaudeCodeProvider(),
  codex: () => new CodexProvider(),
};

/** The ids in a setting such as "claude-code,codex"; throws on one it does not know. */
export function providerIds(setting: string | undefined): string[] {
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
