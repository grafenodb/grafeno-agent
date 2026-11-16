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

/** How a connection signs in. */
export type AuthKind =
  /** The vendor's official program on this computer holds the sign-in (Claude Code, Qwen Code…). */
  | "official-cli"
  /** The official Codex CLI's own "Sign in with ChatGPT". */
  | "official-chatgpt"
  /** The official GitHub Copilot CLI's sign-in with a GitHub account. */
  | "github-account"
  /** A key of the user's for the vendor's API, kept in the environment or the system's secure store. */
  | "api-key"
  /** A key of a membership or prepaid coding plan: not interchangeable with an API key. */
  | "coding-plan-key";

/** How a connection reaches the vendor: the three sections of /connect. */
export type ConnectionType = "cli" | "api-key" | "coding-plan";

/** How what a connection does is paid for, as far as it is known before using it. */
export type CostModel =
  /** A subscription's quota, through the vendor's own program. */
  | "subscription"
  /** A membership or prepaid coding plan's quota. */
  | "plan-quota"
  /** Billed per token: used only when the user allows it (AGENT_ALLOW_BILLING). */
  | "metered"
  /** Free models or a free tier, when the user chose only those. */
  | "free-tier";

/** Where a connection's use stands with its vendor's terms. */
export type ComplianceStatus =
  /** An official, documented interface used as documented. */
  | "documented"
  /** Using a Claude subscription in a third-party orchestrator: Anthropic's answer is awaited. */
  | "pending-anthropic-review"
  /** The vendor limits this key to the coding tools it names: the agent is not one of them. */
  | "restricted-supported-tools"
  /** The vendor's terms say nothing clear about use outside its own tools. */
  | "unverified";

/**
 * A connection: one way to reach one vendor's models (a vendor may have
 * several: Anthropic through Claude Code or through the API). What it is,
 * how it signs in and is paid for, and its standing; its live state
 * (installed, signed in, ready) comes from the connection's own status.
 */
export interface ProviderProfile {
  /** The connection's id: what settings and commands name. */
  readonly id: string;
  /** The vendor (`anthropic`, `openai`…): one vendor, several connections. */
  readonly vendor: string;
  readonly vendorName: string;
  /** Other names it answers to in settings and commands. */
  readonly aliases: readonly string[];
  /** The name shown in tables (an alias may read better than the id). */
  readonly shownAs: string;
  readonly connectionType: ConnectionType;
  readonly auth: AuthKind;
  readonly costModel: CostModel;
  readonly compliance: ComplianceStatus;
  /** On unless switched off; a connection whose terms are uncertain starts off. */
  readonly defaultEnabled: boolean;
  /** What it can do, as its interface documents it. */
  readonly supports: {
    readonly streaming: boolean;
    readonly sessions: boolean;
    readonly tools: boolean;
    readonly mcp: boolean;
    readonly cancellation: boolean;
    readonly headless: boolean;
  };
  /** Where its interface and terms are documented. */
  readonly docs?: string;
  readonly note?: string;
}

const CLI_SUPPORTS = {
  streaming: true,
  sessions: true,
  tools: true,
  mcp: true,
  cancellation: true,
  headless: true,
} as const;
const API_SUPPORTS = {
  streaming: false,
  sessions: true,
  tools: true,
  mcp: true,
  cancellation: true,
  headless: true,
} as const;

function cli(
  id: string,
  vendor: string,
  vendorName: string,
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    vendor,
    vendorName,
    aliases: [],
    shownAs: id,
    connectionType: "cli",
    auth: "official-cli",
    costModel: "subscription",
    compliance: "documented",
    defaultEnabled: true,
    supports: CLI_SUPPORTS,
    ...extra,
  };
}

function api(
  id: string,
  vendor: string,
  vendorName: string,
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    vendor,
    vendorName,
    aliases: [],
    shownAs: id,
    connectionType: "api-key",
    auth: "api-key",
    costModel: "metered",
    compliance: "documented",
    defaultEnabled: true,
    supports: API_SUPPORTS,
    ...extra,
  };
}

function plan(
  id: string,
  vendor: string,
  vendorName: string,
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    vendor,
    vendorName,
    aliases: [],
    shownAs: id,
    connectionType: "coding-plan",
    auth: "coding-plan-key",
    costModel: "plan-quota",
    compliance: "unverified",
    // Its terms do not clearly allow a third-party agent: off until the user turns it on.
    defaultEnabled: false,
    supports: API_SUPPORTS,
    ...extra,
  };
}

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = {
  // CLI / subscription: the vendors' own programs, signed in their own way.
  "claude-code": cli("claude-code", "anthropic", "Anthropic", {
    aliases: ["claude-code-local"],
    shownAs: "claude-code-local",
    compliance: "pending-anthropic-review",
    docs: "https://code.claude.com/docs/en/cli-reference",
    note: "Runs your own, unmodified `claude` program with its own sign-in (claude login). Using a Pro or Max subscription this way, inside a third-party orchestrator, awaits clarification from Anthropic; this is not approved or certified by Anthropic. Enabled for now as a project setting; PROVIDER_CLAUDE_CODE_LOCAL_ENABLED=false turns it off at once.",
  }),
  codex: cli("codex", "openai", "OpenAI", {
    auth: "official-chatgpt",
    docs: "https://learn.chatgpt.com/docs/non-interactive-mode",
    note: "Runs your own `codex` program (codex exec) with its own Sign in with ChatGPT.",
  }),
  copilot: cli("copilot", "github", "GitHub", {
    auth: "github-account",
    docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
    note: "Runs your own `copilot` program as an ACP server (copilot --acp --stdio), signed in with your GitHub account. ACP support is a public preview.",
  }),
  "qwen-code": cli("qwen-code", "alibaba", "Alibaba (Qwen)", {
    docs: "https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed",
    note: "Runs your own `qwen` program as an ACP server (qwen --acp), signed in as `qwen` was set up (/auth). Its free Qwen OAuth tier ended on 2026-04-15.",
  }),
  "kimi-code": cli("kimi-code", "moonshot", "Moonshot AI (Kimi)", {
    docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp",
    note: "Runs your own `kimi` program as an ACP server (kimi acp), signed in with /login.",
  }),
  "mistral-vibe": cli("mistral-vibe", "mistral", "Mistral AI", {
    docs: "https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides",
    note: "Runs your own Mistral Vibe as an ACP server (vibe-acp), signed in with your Mistral account or key.",
  }),
  // API keys: the vendors' official APIs, billed per token.
  "claude-api": api("claude-api", "anthropic", "Anthropic", {
    supports: { ...API_SUPPORTS, streaming: true },
    docs: "https://code.claude.com/docs/en/agent-sdk/overview",
    note: "The official Claude Agent SDK with your Anthropic API key: billed per token, used only with AGENT_ALLOW_BILLING=claude-api.",
  }),
  openai: api("openai", "openai", "OpenAI", {
    docs: "https://platform.openai.com/docs/api-reference",
  }),
  gemini: api("gemini", "google", "Google (Gemini)", {
    docs: "https://ai.google.dev/gemini-api/docs",
    note: "Free tier when you declare it (GEMINI_TIER=free); otherwise billed per token.",
  }),
  deepseek: api("deepseek", "deepseek", "DeepSeek", { docs: "https://api-docs.deepseek.com/" }),
  mistral: api("mistral", "mistral", "Mistral AI", { docs: "https://docs.mistral.ai/api" }),
  moonshot: api("moonshot", "moonshot", "Moonshot AI (Kimi)", {
    docs: "https://platform.moonshot.ai/docs",
  }),
  qwen: api("qwen", "alibaba", "Alibaba (Qwen)", {
    docs: "https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen",
  }),
  zai: api("zai", "zai", "Z.ai (GLM)", { docs: "https://docs.z.ai/" }),
  minimax: api("minimax", "minimax", "MiniMax", { docs: "https://platform.minimax.io/docs" }),
  xai: api("xai", "xai", "xAI (Grok)", { docs: "https://docs.x.ai/developers/quickstart" }),
  openrouter: api("openrouter", "openrouter", "OpenRouter", {
    costModel: "free-tier",
    docs: "https://openrouter.ai/docs",
    note: "Free models only by default (OPENROUTER_MODELS=free); paid ones bill per token.",
  }),
  // Coding plans: membership keys, not interchangeable with API keys.
  "kimi-plan": plan("kimi-plan", "moonshot", "Moonshot AI (Kimi)", {
    docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html",
    note: "A Kimi Code membership key, on its own endpoint (api.kimi.com/coding). Whether its terms allow a third-party agent is not stated: off until you turn it on.",
  }),
  "zai-plan": plan("zai-plan", "zai", "Z.ai (GLM)", {
    compliance: "restricted-supported-tools",
    docs: "https://docs.z.ai/scenario-example/develop-tools/others",
    note: "A GLM Coding Plan key, on its own endpoint. Z.ai limits it to the coding tools it lists, and this agent is not one of them: off unless you turn it on, at your own risk.",
  }),
  "minimax-plan": plan("minimax-plan", "minimax", "MiniMax", {
    docs: "https://platform.minimax.io/docs/m-plan/quickstart",
    note: "A MiniMax Coding (Token) Plan key, not interchangeable with a pay-as-you-go key. Whether its terms allow a third-party agent is not stated: off until you turn it on.",
  }),
  "qwen-plan": plan("qwen-plan", "alibaba", "Alibaba (Qwen)", {
    compliance: "restricted-supported-tools",
    docs: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
    note: "An Alibaba Cloud Coding Plan key (sk-sp-), on its own endpoint. Alibaba lists the tools it supports, and this agent is not one of them: off unless you turn it on, at your own risk.",
  }),
};

/** The connection's id for a name or alias (`claude-code-local` → `claude-code`); itself otherwise. */
export function canonicalProvider(name: string): string {
  const wanted = name.trim();
  for (const profile of Object.values(PROVIDER_PROFILES)) {
    if (profile.id === wanted || profile.aliases.includes(wanted)) return profile.id;
  }
  return wanted;
}

/** The settings that switch a connection on or off: `PROVIDER_<NAME>_ENABLED`, for its id and aliases. */
export function switchVariables(id: string): string[] {
  const profile = PROVIDER_PROFILES[id];
  const names = [...(profile?.aliases ?? []), id];
  return names.map((n) => `PROVIDER_${n.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ENABLED`);
}

/**
 * Whether a connection is switched on: as one of its switches says, else
 * as its profile starts (a coding plan of uncertain terms starts off).
 * Read each time, so turning one off takes effect at once.
 */
export function providerEnabled(
  id: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const values = switchVariables(id).map((name) => env[name]?.trim() ?? "");
  if (values.some((v) => /^(false|0|off|no)$/i.test(v))) return false;
  if (values.some((v) => /^(true|1|on|yes)$/i.test(v))) return true;
  return PROVIDER_PROFILES[id]?.defaultEnabled ?? true;
}

function disabledDetail(id: string, env: Record<string, string | undefined> = process.env): string {
  const shown = PROVIDER_PROFILES[id]?.shownAs ?? id;
  const name = switchVariables(id)[0] ?? "";
  const set = switchVariables(id).some((n) => (env[n]?.trim() ?? "") !== "");
  return `Switched off (${set ? `${name}=false` : "off until you switch it on"}): grafeno-agent providers enable ${shown} switches it on.`;
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
        detail: disabledDetail(this.id, this.env()),
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
      open: () => Promise.reject(new ModelError("setup", disabledDetail(id, this.env()))),
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
