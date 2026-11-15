import { dataDir } from "../data-dir.js";
import { ModelError } from "../model/errors.js";
import { resilient } from "../model/index.js";
import { ChatCompletionsModel } from "../model/openai-chat.js";
import type { ResilienceOptions } from "../model/resilient.js";
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

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** The secret store's account for the key. */
export const OPENROUTER_ACCOUNT = "openrouter-api-key";
/** OpenRouter's router that picks a free model, and falls back only to free ones. */
export const FREE_ROUTER = "openrouter/free";
const PAID_ROUTER = "openrouter/auto";
/** The app's name for OpenRouter (optional; never anything about the user). */
const HEADERS = { "X-OpenRouter-Title": "Grafeno Agent" };

export interface OpenRouterSettings {
  /** Where `OPENROUTER_API_KEY` and `OPENROUTER_MODELS` are read. */
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetch?: typeof fetch;
  readonly api?: string;
  /** How turns are retried; for tests (such as no waits between tries). */
  readonly resilience?: ResilienceOptions;
}

/** `free` (the default): only free models, never billed; `all`: models billed per token. */
export function openRouterModels(env: Record<string, string | undefined>): "free" | "all" {
  return env.OPENROUTER_MODELS?.trim().toLowerCase() === "all" ? "all" : "free";
}

/** Whether a model id is one of OpenRouter's free ones. */
export function isFreeModel(id: string): boolean {
  return id === FREE_ROUTER || id.endsWith(":free");
}

/** How OpenRouter is paid for, as the user chose: free models only, or credits per token. */
export function openRouterBilling(models: "free" | "all"): Billing {
  return models === "free"
    ? { kind: "free-api", detail: "OpenRouter's free models only (no charge)" }
    : { kind: "metered", detail: "OpenRouter's models billed per token from your credits" };
}

/** Where the key comes from: the environment, else the system's secure store. */
export class OpenRouterCredential {
  constructor(private readonly settings: OpenRouterSettings) {}

  async read(): Promise<{ key: string; from: string } | undefined> {
    const env = this.settings.env ?? process.env;
    const value = env.OPENROUTER_API_KEY?.trim();
    if (value) return { key: value, from: "OPENROUTER_API_KEY" };
    const store = this.store();
    const stored = await store.get(OPENROUTER_ACCOUNT).catch(() => undefined);
    return stored ? { key: stored, from: store.name } : undefined;
  }

  key = async (): Promise<string | undefined> => (await this.read())?.key;

  store(): SecretStore {
    return this.settings.store ?? systemSecretStore(dataDir(this.settings.env ?? process.env));
  }
}

/** What OpenRouter says about a key (`GET /key`), without spending anything. */
export interface KeyInfo {
  readonly label?: string;
  readonly limit?: number | null;
  readonly usage?: number;
  readonly limit_remaining?: number | null;
  /** Whether the account never bought credits. */
  readonly is_free_tier?: boolean;
  readonly free_model_daily_requests?: { used?: number; limit?: number; remaining?: number };
}

/** Checks a key with OpenRouter: what it says about it, or why it refused it. */
export async function checkOpenRouterKey(
  key: string,
  options: { fetch?: typeof fetch; api?: string } = {},
): Promise<{ ok: true; info: KeyInfo } | { ok: false; status?: number; reason: string }> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.api ?? OPENROUTER_API}/key`, {
      headers: { ...HEADERS, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: "OpenRouter could not be reached" };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason:
        response.status === 401
          ? "OpenRouter refused the key (invalid or disabled)"
          : `OpenRouter answered HTTP ${String(response.status)}`,
    };
  }
  const body = (await response.json().catch(() => ({}))) as { data?: KeyInfo };
  return { ok: true, info: body.data ?? {} };
}

/**
 * OpenRouter's authentication: the user's own API key, checked with
 * OpenRouter's key endpoint, which spends nothing. Its billing follows the
 * user's choice of models: free ones only (the default) or paid ones.
 */
export class OpenRouterAuth implements ProviderAuth {
  readonly method = "api-key";
  readonly signIn =
    "Create a key at openrouter.ai/settings/keys, then run `grafeno-agent login openrouter` (or set OPENROUTER_API_KEY).";

  constructor(
    private readonly credential: OpenRouterCredential,
    private readonly settings: OpenRouterSettings,
  ) {}

  async status(): Promise<ProviderStatus> {
    const found = await this.credential.read();
    if (!found) return { installed: true, signedIn: false, detail: this.signIn };
    const checked = await checkOpenRouterKey(found.key, this.settings);
    if (!checked.ok && checked.status !== undefined) {
      return { installed: true, signedIn: false, detail: `${checked.reason}. ${this.signIn}` };
    }
    const models = openRouterModels(this.settings.env ?? process.env);
    const billing = openRouterBilling(models);
    return {
      installed: true,
      signedIn: true,
      plan: models === "free" ? "OpenRouter (free models)" : "OpenRouter (credits)",
      billing,
      detail: `Key from ${found.from}${checked.ok ? "" : " (not checked: OpenRouter was not reachable)"}. ${billing.detail}.`,
    };
  }

  /** The day's free requests and the key's credit limit, as OpenRouter reports them. */
  async usage(): Promise<ProviderUsage | undefined> {
    const key = await this.credential.key();
    if (!key) return undefined;
    const checked = await checkOpenRouterKey(key, this.settings);
    if (!checked.ok) return undefined;
    const limits = openRouterLimits(checked.info);
    if (limits.length === 0) return undefined;
    return {
      limits,
      at: new Date(),
      note: checked.info.is_free_tier ? "OpenRouter, free tier" : "OpenRouter",
    };
  }
}

/** OpenRouter's key info as usage windows: free requests today, and the credit limit. */
export function openRouterLimits(info: KeyInfo): UsageLimit[] {
  const out: UsageLimit[] = [];
  const free = info.free_model_daily_requests;
  if (free?.limit && free.limit > 0) {
    out.push({ label: "Free requests today", used: Math.min(1, (free.used ?? 0) / free.limit) });
  }
  if (typeof info.limit === "number" && info.limit > 0) {
    out.push({ label: "Credit limit", used: Math.min(1, (info.usage ?? 0) / info.limit) });
  }
  return out;
}

interface OpenRouterModelInfo {
  id?: string;
  name?: string;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** OpenRouter's model selection: free models only by default, each able to use tools. */
export class OpenRouterCatalog implements ModelCatalog {
  readonly #names = new Map<string, string>();

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly settings: OpenRouterSettings,
  ) {}

  get tiers() {
    const router = this.#mode() === "free" ? FREE_ROUTER : PAID_ROUTER;
    return { deep: [router], standard: [router], light: [router] };
  }

  async models(): Promise<readonly ModelOption[]> {
    const key = await this.key();
    let found: OpenRouterModelInfo[] = [];
    try {
      const answer = await (this.settings.fetch ?? fetch)(
        `${this.settings.api ?? OPENROUTER_API}/models?supported_parameters=tools`,
        {
          headers: { ...HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (answer.ok) found = ((await answer.json()) as { data?: OpenRouterModelInfo[] }).data ?? [];
    } catch {
      // Listed again next time.
    }
    const free = this.#mode() === "free";
    const usable = found.filter(
      (m) =>
        typeof m.id === "string" &&
        (m.supported_parameters === undefined || m.supported_parameters.includes("tools")) &&
        (!free ||
          (m.id.endsWith(":free") && m.pricing?.prompt === "0" && m.pricing.completion === "0")),
    );
    for (const m of usable) if (m.id && m.name) this.#names.set(m.id, m.name);
    return [
      {
        id: "default",
        name: "Auto",
        hint: free
          ? `${FREE_ROUTER}: a free model, never a paid one`
          : `${PAID_ROUTER}: OpenRouter's own choice (billed)`,
      },
      ...usable.map((m) => ({
        id: m.id ?? "",
        name: m.name ?? m.id ?? "",
        ...(m.description ? { hint: m.description.split("\n", 1)[0] ?? "" } : {}),
      })),
    ];
  }

  efforts(): readonly string[] {
    return this.#mode() === "free" ? [] : ["low", "medium", "high"];
  }

  modelName(id: string): string {
    return this.#names.get(id) ?? id;
  }

  #mode() {
    return openRouterModels(this.settings.env ?? process.env);
  }
}

/**
 * OpenRouter's execution: chat completions with the agent's tools. With
 * free models only, a model that is not free is refused before any
 * request, and no fallback list is ever sent: nothing can be billed.
 */
export class OpenRouterRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: false,
    keepsConversation: true,
    usageReport: true,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly settings: OpenRouterSettings,
  ) {}

  create(choice: ModelChoice): Model {
    const free = openRouterModels(this.settings.env ?? process.env) === "free";
    const model =
      choice.model === undefined || choice.model === "default"
        ? free
          ? FREE_ROUTER
          : PAID_ROUTER
        : choice.model;
    if (free && !isFreeModel(model)) return refused(model);
    return resilient(
      new ChatCompletionsModel({
        name: "OpenRouter",
        api: this.settings.api ?? OPENROUTER_API,
        model,
        ...(choice.effort === undefined || free ? {} : { effort: choice.effort }),
        key: this.key,
        headers: HEADERS,
        noKey: "No OpenRouter API key: grafeno-agent login openrouter sets one up.",
        ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
      }),
      this.settings.resilience,
    );
  }
}

/** A model that is never asked: a paid model while only free ones are allowed. */
function refused(model: string): Model {
  return {
    name: "openrouter",
    open: () =>
      Promise.reject(
        new ModelError(
          "setup",
          `${model} is not a free model, and OpenRouter is set to free models only (OPENROUTER_MODELS=all allows paid ones, with AGENT_ALLOW_BILLING=openrouter).`,
        ),
      ),
  };
}

/** OpenRouter with the user's own key: its three parts, as one provider. */
export class OpenRouterProvider extends ComposedProvider {
  constructor(settings: OpenRouterSettings = {}) {
    const credential = new OpenRouterCredential(settings);
    super("openrouter", "OpenRouter (API key)", {
      auth: new OpenRouterAuth(credential, settings),
      catalog: new OpenRouterCatalog(credential.key, settings),
      runtime: new OpenRouterRuntime(credential.key, settings),
    });
  }
}

/** Where the key is kept on this machine, for `login openrouter`. */
export function openRouterStore(
  env: Record<string, string | undefined> = process.env,
): SecretStore {
  return systemSecretStore(dataDir(env));
}
