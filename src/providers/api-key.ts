import { dataDir } from "../data-dir.js";
import { ModelError } from "../model/errors.js";
import { resilient } from "../model/index.js";
import { ChatCompletionsModel } from "../model/openai-chat.js";
import type { Model } from "../model/types.js";
import { ComposedProvider } from "./compose.js";
import { systemSecretStore, type SecretStore } from "./secrets.js";
import type {
  Billing,
  ModelCatalog,
  ModelChoice,
  ModelOption,
  ProviderAuth,
  ProviderRuntime,
  ProviderStatus,
  ProviderUsage,
  UsageLimit,
} from "./types.js";

/** One of a vendor's documented endpoints (a region, a mainland host). */
export interface Endpoint {
  readonly id: string;
  readonly url: string;
  readonly label: string;
}

/**
 * A connection by key to a vendor's OpenAI-compatible chat API (an API
 * key, or a coding plan's own key on its own endpoint): what its
 * documentation says, and nothing more.
 */
export interface ApiKeySpec {
  readonly id: string;
  readonly name: string;
  readonly kind: "api-key" | "coding-plan";
  /** Environment variables the key may come from, in order. */
  readonly keyVariables: readonly string[];
  /** The documented endpoints; the first is the default. */
  readonly endpoints: readonly Endpoint[];
  /** Lists the models (and so checks the key) without spending anything; undefined when the API has none. */
  readonly modelsPath?: string;
  readonly signIn: string;
  readonly pricing?: string;
  /** The account's balance, when the API reports it for free. */
  readonly balance?: (
    get: (path: string) => Promise<Response>,
  ) => Promise<readonly UsageLimit[] | undefined>;
  /** Model ids per tier, when the vendor documents lasting aliases. */
  readonly tiers?: Readonly<Record<"deep" | "standard" | "light", readonly string[]>>;
}

/** The setting that picks one of a connection's documented endpoints: `<ID>_ENDPOINT`. */
export function endpointVariable(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ENDPOINT`;
}

/** The secure store's account for a connection's key. */
export function keyAccount(id: string): string {
  return `${id}-key`;
}

/** The endpoint a connection uses: the one its setting names among the documented ones, else the first. */
export function endpointOf(spec: ApiKeySpec, env: Record<string, string | undefined>): Endpoint {
  const wanted = env[endpointVariable(spec.id)]?.trim();
  const fallback = spec.endpoints[0];
  if (!fallback) throw new Error(`${spec.id} has no endpoint`);
  return spec.endpoints.find((e) => e.id === wanted || e.url === wanted) ?? fallback;
}

const deepseekBalance: ApiKeySpec["balance"] = async (get) => {
  const answer = await get("/user/balance");
  if (!answer.ok) return undefined;
  const body = (await answer.json()) as {
    is_available?: boolean;
    balance_infos?: { currency?: string; total_balance?: string }[];
  };
  const info = body.balance_infos?.[0];
  if (!info) return undefined;
  // A balance, not a share of a limit: shown as a label, empty or not.
  return [
    {
      label: `Balance ${info.total_balance ?? "?"} ${info.currency ?? ""}`.trim(),
      used: body.is_available === false ? 1 : 0,
    },
  ];
};

const minimaxPlanRemains: ApiKeySpec["balance"] = async (get) => {
  const answer = await get("/token_plan/remains");
  if (!answer.ok) return undefined;
  const body = (await answer.json()) as {
    model_remains?: {
      model_name?: string;
      current_interval_total_count?: number;
      current_interval_usage_count?: number;
    }[];
  };
  return (body.model_remains ?? [])
    .filter((m) => (m.current_interval_total_count ?? 0) > 0)
    .map((m) => ({
      label: m.model_name ?? "Plan",
      used: Math.min(
        1,
        (m.current_interval_usage_count ?? 0) / (m.current_interval_total_count ?? 1),
      ),
    }));
};

/** The vendors reached with a key, as their documentation describes them. */
export const API_KEY_SPECS: readonly ApiKeySpec[] = [
  {
    id: "openai",
    name: "OpenAI API",
    kind: "api-key",
    keyVariables: ["OPENAI_API_KEY"],
    endpoints: [{ id: "global", url: "https://api.openai.com/v1", label: "api.openai.com" }],
    modelsPath: "/models",
    signIn: "Create an API key at platform.openai.com/api-keys, then: grafeno-agent login openai.",
    pricing: "https://openai.com/api/pricing",
  },
  {
    id: "deepseek",
    name: "DeepSeek API",
    kind: "api-key",
    keyVariables: ["DEEPSEEK_API_KEY"],
    endpoints: [{ id: "global", url: "https://api.deepseek.com", label: "api.deepseek.com" }],
    modelsPath: "/models",
    signIn: "Create an API key at platform.deepseek.com, then: grafeno-agent login deepseek.",
    pricing: "https://api-docs.deepseek.com/quick_start/pricing",
    balance: deepseekBalance,
  },
  {
    id: "mistral",
    name: "Mistral API",
    kind: "api-key",
    keyVariables: ["MISTRAL_API_KEY"],
    endpoints: [{ id: "global", url: "https://api.mistral.ai/v1", label: "api.mistral.ai" }],
    modelsPath: "/models",
    signIn:
      "Create an API key in Mistral AI Studio (console.mistral.ai), then: grafeno-agent login mistral.",
    pricing: "https://mistral.ai/pricing",
    tiers: {
      deep: ["mistral-large-latest", "mistral-medium-latest"],
      standard: ["mistral-medium-latest", "mistral-small-latest"],
      light: ["mistral-small-latest"],
    },
  },
  {
    id: "moonshot",
    name: "Moonshot AI API (Kimi)",
    kind: "api-key",
    keyVariables: ["MOONSHOT_API_KEY"],
    endpoints: [
      { id: "global", url: "https://api.moonshot.ai/v1", label: "api.moonshot.ai" },
      { id: "china", url: "https://api.moonshot.cn/v1", label: "api.moonshot.cn (mainland China)" },
    ],
    modelsPath: "/models",
    signIn: "Create an API key at platform.moonshot.ai, then: grafeno-agent login moonshot.",
    pricing: "https://platform.moonshot.ai/docs/pricing",
  },
  {
    id: "qwen",
    name: "Alibaba Cloud Model Studio (Qwen)",
    kind: "api-key",
    keyVariables: ["DASHSCOPE_API_KEY"],
    endpoints: [
      {
        id: "singapore",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        label: "Singapore (international)",
      },
      { id: "beijing", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", label: "Beijing" },
    ],
    modelsPath: "/models",
    signIn: "Create an API key in Alibaba Cloud Model Studio, then: grafeno-agent login qwen.",
    pricing: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  },
  {
    id: "zai",
    name: "Z.ai API (GLM)",
    kind: "api-key",
    keyVariables: ["ZAI_API_KEY"],
    endpoints: [{ id: "global", url: "https://api.z.ai/api/paas/v4", label: "api.z.ai" }],
    modelsPath: "/models",
    signIn: "Create an API key at z.ai, then: grafeno-agent login zai.",
    pricing: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    id: "minimax",
    name: "MiniMax API",
    kind: "api-key",
    keyVariables: ["MINIMAX_API_KEY"],
    endpoints: [
      { id: "global", url: "https://api.minimax.io/v1", label: "api.minimax.io" },
      {
        id: "china",
        url: "https://api.minimaxi.com/v1",
        label: "api.minimaxi.com (mainland China)",
      },
    ],
    signIn:
      "Create a pay-as-you-go API key at platform.minimax.io, then: grafeno-agent login minimax.",
    pricing: "https://platform.minimax.io/docs/guides/pricing",
  },
  {
    id: "xai",
    name: "xAI API (Grok)",
    kind: "api-key",
    keyVariables: ["XAI_API_KEY"],
    endpoints: [
      { id: "global", url: "https://api.x.ai/v1", label: "api.x.ai" },
      { id: "us", url: "https://us.api.x.ai/v1", label: "us.api.x.ai (United States)" },
    ],
    modelsPath: "/models",
    signIn: "Create an API key at console.x.ai, then: grafeno-agent login xai.",
    pricing: "https://docs.x.ai/docs/models",
  },
  {
    id: "kimi-plan",
    name: "Kimi Code membership (Coding Plan)",
    kind: "coding-plan",
    keyVariables: ["KIMI_CODE_API_KEY"],
    endpoints: [
      { id: "global", url: "https://api.kimi.com/coding/v1", label: "api.kimi.com/coding" },
    ],
    modelsPath: "/models",
    signIn:
      "Create a Kimi Code key in your Kimi membership's console, then: grafeno-agent login kimi-plan.",
  },
  {
    id: "zai-plan",
    name: "GLM Coding Plan (Z.ai)",
    kind: "coding-plan",
    keyVariables: ["ZAI_CODING_API_KEY"],
    endpoints: [
      {
        id: "global",
        url: "https://api.z.ai/api/coding/paas/v4",
        label: "api.z.ai coding endpoint",
      },
    ],
    modelsPath: "/models",
    signIn: "Use your GLM Coding Plan key (z.ai), then: grafeno-agent login zai-plan.",
  },
  {
    id: "minimax-plan",
    name: "MiniMax Coding (Token) Plan",
    kind: "coding-plan",
    keyVariables: ["MINIMAX_CODING_API_KEY"],
    endpoints: [
      { id: "global", url: "https://api.minimax.io/v1", label: "api.minimax.io" },
      {
        id: "china",
        url: "https://api.minimaxi.com/v1",
        label: "api.minimaxi.com (mainland China)",
      },
    ],
    signIn:
      "Use your Coding Plan key (sk-cp-…, platform.minimax.io), then: grafeno-agent login minimax-plan.",
    balance: minimaxPlanRemains,
  },
  {
    id: "qwen-plan",
    name: "Alibaba Cloud Coding Plan (Qwen)",
    kind: "coding-plan",
    keyVariables: ["DASHSCOPE_CODING_API_KEY"],
    endpoints: [
      {
        id: "international",
        url: "https://coding-intl.dashscope.aliyuncs.com/v1",
        label: "coding-intl.dashscope.aliyuncs.com",
      },
    ],
    signIn:
      "Use your Coding Plan key (sk-sp-…, Model Studio), then: grafeno-agent login qwen-plan.",
  },
];

export interface ApiKeySettings {
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetch?: typeof fetch;
}

/** Where a connection's key comes from: its variables, else the system's secure store. */
export class ApiKeyCredential {
  constructor(
    private readonly spec: ApiKeySpec,
    private readonly settings: ApiKeySettings,
  ) {}

  async read(): Promise<{ key: string; from: string } | undefined> {
    const env = this.settings.env ?? process.env;
    for (const name of this.spec.keyVariables) {
      const value = env[name]?.trim();
      if (value) return { key: value, from: name };
    }
    const store = this.store();
    const stored = await store.get(keyAccount(this.spec.id)).catch(() => undefined);
    return stored ? { key: stored, from: store.name } : undefined;
  }

  key = async (): Promise<string | undefined> => (await this.read())?.key;

  store(): SecretStore {
    return this.settings.store ?? systemSecretStore(dataDir(this.settings.env ?? process.env));
  }
}

/** A key checked with the vendor, spending nothing: accepted, refused, or not checkable. */
export type KeyCheck =
  | { readonly ok: true; readonly models: readonly ModelOption[] }
  | { readonly ok: false; readonly refused: boolean; readonly reason: string };

/**
 * Checks a key by listing models on its endpoint (free); a 401 or 403 is a
 * refused key. A connection whose API lists no models cannot be checked
 * for free: said, never guessed by spending.
 */
export async function checkKey(
  spec: ApiKeySpec,
  key: string,
  options: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {},
): Promise<KeyCheck> {
  if (!spec.modelsPath) {
    return {
      ok: false,
      refused: false,
      reason: `${spec.name} has no free way to check a key: it is checked on its first use`,
    };
  }
  const base = endpointOf(spec, options.env ?? process.env).url;
  let answer: Response;
  try {
    answer = await (options.fetch ?? fetch)(`${base}${spec.modelsPath}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, refused: false, reason: `${spec.name} could not be reached` };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, refused: true, reason: `${spec.name} refused the key` };
  }
  if (!answer.ok) {
    return {
      ok: false,
      refused: false,
      reason: `${spec.name} answered HTTP ${String(answer.status)}`,
    };
  }
  const body = (await answer.json().catch(() => ({}))) as {
    data?: { id?: string; name?: string; display_name?: string }[];
  };
  const models = (body.data ?? [])
    .filter(
      (m): m is { id: string; name?: string; display_name?: string } => typeof m.id === "string",
    )
    .map((m) => ({ id: m.id, name: m.display_name ?? m.name ?? m.id }));
  return { ok: true, models };
}

/** How a connection by key is paid for: an API bills per token; a plan spends its quota. */
export function keyBilling(spec: ApiKeySpec): Billing {
  return spec.kind === "coding-plan"
    ? { kind: "subscription", detail: `${spec.name}: the plan's quota` }
    : { kind: "metered", detail: `${spec.name}, billed per token` };
}

/** A connection by key's authentication: the key, checked with the vendor without spending. */
export class ApiKeyAuth implements ProviderAuth {
  readonly method = "api-key";

  constructor(
    private readonly spec: ApiKeySpec,
    private readonly credential: ApiKeyCredential,
    private readonly settings: ApiKeySettings,
  ) {}

  get signIn(): string {
    return this.spec.signIn;
  }

  async status(): Promise<ProviderStatus> {
    const found = await this.credential.read();
    if (!found) return { installed: true, signedIn: false, detail: this.spec.signIn };
    const env = this.settings.env ?? process.env;
    const checked = await checkKey(this.spec, found.key, {
      env,
      ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
    });
    if (!checked.ok && checked.refused) {
      return { installed: true, signedIn: false, detail: `${checked.reason}. ${this.spec.signIn}` };
    }
    const billing = keyBilling(this.spec);
    const endpoint = endpointOf(this.spec, env);
    return {
      installed: true,
      signedIn: true,
      plan: this.spec.kind === "coding-plan" ? "Coding plan" : "API",
      billing,
      detail: `Key from ${found.from} · ${endpoint.label}${checked.ok ? "" : ` (${checked.reason})`}. ${billing.detail}${this.spec.pricing ? `: prices at ${this.spec.pricing}` : ""}.`,
    };
  }

  /** The balance or plan quota, when the vendor's API reports it for free. */
  async usage(): Promise<ProviderUsage | undefined> {
    const key = await this.credential.key();
    if (!key || !this.spec.balance) return undefined;
    const base = endpointOf(this.spec, this.settings.env ?? process.env).url;
    try {
      const limits = await this.spec.balance((path) =>
        (this.settings.fetch ?? fetch)(`${base}${path}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        }),
      );
      return limits && limits.length > 0 ? { limits, at: new Date() } : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A connection by key's model selection: the vendor's own list of models. */
export class ApiKeyCatalog implements ModelCatalog {
  #models: readonly ModelOption[] | undefined;

  constructor(
    private readonly spec: ApiKeySpec,
    private readonly credential: ApiKeyCredential,
    private readonly settings: ApiKeySettings,
  ) {}

  get tiers() {
    return this.spec.tiers ?? { deep: ["default"], standard: ["default"], light: ["default"] };
  }

  async models(): Promise<readonly ModelOption[]> {
    const key = await this.credential.key();
    const listed =
      key === undefined
        ? []
        : await checkKey(this.spec, key, {
            env: this.settings.env ?? process.env,
            ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
          }).then((c) => (c.ok ? c.models : []));
    this.#models = listed;
    return [
      { id: "default", name: "Auto", hint: `${this.spec.name}'s first listed model` },
      ...listed,
    ];
  }

  efforts(): readonly string[] {
    return [];
  }

  modelName(id: string): string {
    return this.#models?.find((m) => m.id === id)?.name ?? id;
  }

  /** The model used when none was chosen: the first the vendor lists. */
  async defaultModel(): Promise<string> {
    const listed = this.#models ?? (await this.models()).filter((m) => m.id !== "default");
    const first = listed.find((m) => m.id !== "default");
    if (!first) {
      throw new ModelError(
        "setup",
        `${this.spec.name} listed no model to use by default: choose one with /models.`,
      );
    }
    return first.id;
  }
}

/** A connection by key's execution: chat completions with the agent's tools, by the shared adapter. */
export class ApiKeyRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: false,
    keepsConversation: true,
    usageReport: false,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly spec: ApiKeySpec,
    private readonly credential: ApiKeyCredential,
    private readonly catalog: ApiKeyCatalog,
    private readonly settings: ApiKeySettings,
  ) {}

  create(choice: ModelChoice): Model {
    const env = this.settings.env ?? process.env;
    const chosen =
      choice.model === undefined || choice.model === "default" ? undefined : choice.model;
    return resilient(
      new ChatCompletionsModel({
        name: this.spec.name,
        api: endpointOf(this.spec, env).url,
        model: chosen ?? (() => this.catalog.defaultModel()),
        key: this.credential.key,
        noKey: `No key for ${this.spec.name}: grafeno-agent login ${this.spec.id}.`,
        ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
      }),
    );
  }
}

/** A vendor reached with a key: its three parts, as one connection. */
export class ApiKeyProvider extends ComposedProvider {
  constructor(spec: ApiKeySpec, settings: ApiKeySettings = {}) {
    const credential = new ApiKeyCredential(spec, settings);
    const catalog = new ApiKeyCatalog(spec, credential, settings);
    super(spec.id, spec.name, {
      auth: new ApiKeyAuth(spec, credential, settings),
      catalog,
      runtime: new ApiKeyRuntime(spec, credential, catalog, settings),
    });
  }
}

/** A connection's spec by its id. */
export function apiKeySpec(id: string): ApiKeySpec | undefined {
  return API_KEY_SPECS.find((s) => s.id === id);
}
