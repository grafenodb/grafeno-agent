import { ModelError } from "../model/errors.js";
import type { Model } from "../model/types.js";
import { ComposedProvider } from "./compose.js";
import type {
  ModelChoice,
  Provider,
  ProviderAuth,
  ProviderRuntime,
  ProviderStatus,
  ProviderUsage,
} from "./types.js";

/** How a provider signs in. */
export type AuthKind =
  /** The provider's official program on this computer holds the sign-in (Claude Code). */
  | "official-cli"
  /** The official Codex CLI's own "Sign in with ChatGPT". */
  | "official-chatgpt"
  /** A key of the user's, kept in the environment or the system's secure store. */
  | "api-key";

/** What is known about a provider beyond its code: how it signs in, and its standing. */
export interface ProviderProfile {
  readonly id: string;
  /** Other names it answers to in settings and commands. */
  readonly aliases: readonly string[];
  /** The name shown in the providers table (an alias may read better than the id). */
  readonly shownAs: string;
  readonly auth: AuthKind;
  /** Set when its use is not settled with its maker: shown wherever it is listed. */
  readonly compliance?: "pending-anthropic-review";
  readonly note?: string;
}

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = {
  "claude-code": {
    id: "claude-code",
    aliases: ["claude-code-local"],
    shownAs: "claude-code-local",
    auth: "official-cli",
    compliance: "pending-anthropic-review",
    note: "Runs your own, unmodified `claude` program with its own sign-in (claude login). Using a Pro or Max subscription this way, inside a third-party orchestrator, awaits clarification from Anthropic; this is not approved or certified by Anthropic. Enabled for now as a project setting; PROVIDER_CLAUDE_CODE_LOCAL_ENABLED=false turns it off at once.",
  },
  "claude-api": {
    id: "claude-api",
    aliases: [],
    shownAs: "claude-api",
    auth: "api-key",
    note: "The official Claude Agent SDK with your Anthropic API key: billed per token, used only with AGENT_ALLOW_BILLING=claude-api.",
  },
  codex: {
    id: "codex",
    aliases: [],
    shownAs: "codex",
    auth: "official-chatgpt",
    note: "Runs your own `codex` program (codex exec) with its own Sign in with ChatGPT.",
  },
  gemini: { id: "gemini", aliases: [], shownAs: "gemini", auth: "api-key" },
  openrouter: { id: "openrouter", aliases: [], shownAs: "openrouter", auth: "api-key" },
};

/** The provider's id for a name or alias (`claude-code-local` → `claude-code`); itself otherwise. */
export function canonicalProvider(name: string): string {
  const wanted = name.trim();
  for (const profile of Object.values(PROVIDER_PROFILES)) {
    if (profile.id === wanted || profile.aliases.includes(wanted)) return profile.id;
  }
  return wanted;
}

/** The settings that switch a provider on or off: `PROVIDER_<NAME>_ENABLED`, for its id and aliases. */
export function switchVariables(id: string): string[] {
  const profile = PROVIDER_PROFILES[id];
  const names = [...(profile?.aliases ?? []), id];
  return names.map((n) => `PROVIDER_${n.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ENABLED`);
}

/**
 * Whether a provider is switched on: every provider is, unless one of its
 * switches says false (false, 0, off, no). Read each time, so turning one
 * off takes effect at once.
 */
export function providerEnabled(
  id: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !switchVariables(id).some((name) => /^(false|0|off|no)$/i.test(env[name]?.trim() ?? ""));
}

function disabledDetail(id: string): string {
  const shown = PROVIDER_PROFILES[id]?.shownAs ?? id;
  return `Switched off (${switchVariables(id)[0] ?? ""}=false): grafeno-agent providers enable ${shown} switches it on.`;
}

/** A provider's sign-in part behind its switch: switched off, it is never asked. */
class SwitchedAuth implements ProviderAuth {
  constructor(
    private readonly id: string,
    private readonly inner: ProviderAuth,
    private readonly env: () => Record<string, string | undefined>,
  ) {}

  get method() {
    return this.inner.method;
  }

  get signIn() {
    return this.inner.signIn;
  }

  status(): Promise<ProviderStatus> {
    if (!providerEnabled(this.id, this.env())) {
      return Promise.resolve({
        installed: false,
        signedIn: false,
        detail: disabledDetail(this.id),
      });
    }
    return this.inner.status();
  }

  usage(options?: { fresh?: boolean }): Promise<ProviderUsage | undefined> {
    if (!providerEnabled(this.id, this.env())) return Promise.resolve(undefined);
    return this.inner.usage(options);
  }
}

/** A provider's execution part behind its switch: switched off, no model starts. */
class SwitchedRuntime implements ProviderRuntime {
  constructor(
    private readonly id: string,
    private readonly inner: ProviderRuntime,
    private readonly env: () => Record<string, string | undefined>,
  ) {}

  get features() {
    return this.inner.features;
  }

  create(choice: ModelChoice): Model {
    if (providerEnabled(this.id, this.env())) return this.inner.create(choice);
    const id = this.id;
    return {
      name: id,
      open: () => Promise.reject(new ModelError("setup", disabledDetail(id))),
    };
  }
}

/** A provider behind its switch (checked before anything else, the cache included). */
export function withSwitch(
  provider: Provider,
  env: () => Record<string, string | undefined> = () => process.env,
): Provider {
  if (!(provider instanceof ComposedProvider)) return provider;
  return new ComposedProvider(provider.id, provider.name, {
    auth: new SwitchedAuth(provider.id, provider.parts.auth, env),
    catalog: provider.parts.catalog,
    runtime: new SwitchedRuntime(provider.id, provider.parts.runtime, env),
  });
}
