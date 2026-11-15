import { dataDir } from "../data-dir.js";
import { GEMINI_API, GeminiModel } from "../model/gemini.js";
import { resilient } from "../model/index.js";
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
} from "./types.js";

/** The secret store's account for the key. */
export const GEMINI_ACCOUNT = "gemini-api-key";

/** What `generateContent` model the agent uses when none is chosen. */
const AUTO_MODEL = "gemini-flash-latest";

export interface GeminiSettings {
  /** Where `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GEMINI_TIER` are read. */
  readonly env?: Record<string, string | undefined>;
  /** The system's secure store; default: this platform's. */
  readonly store?: SecretStore;
  readonly fetch?: typeof fetch;
  readonly api?: string;
}

/**
 * Where the key comes from: the environment, else the system's secure
 * store. Only this object reads it; the other parts get a function that
 * asks it, and nothing writes it anywhere else.
 */
export class GeminiCredential {
  constructor(private readonly settings: GeminiSettings) {}

  /** The key, or undefined; with where it was found. */
  async read(): Promise<{ key: string; from: string } | undefined> {
    const env = this.settings.env ?? process.env;
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      const value = env[name]?.trim();
      if (value) return { key: value, from: name };
    }
    const store = this.store();
    const stored = await store.get(GEMINI_ACCOUNT).catch(() => undefined);
    return stored ? { key: stored, from: store.name } : undefined;
  }

  key = async (): Promise<string | undefined> => (await this.read())?.key;

  store(): SecretStore {
    return this.settings.store ?? systemSecretStore(dataDir(this.settings.env ?? process.env));
  }
}

/** The tier the user declared for their key: `free` (no billing) or `paid`. */
export function geminiTier(env: Record<string, string | undefined>): "free" | "paid" | undefined {
  const tier = env.GEMINI_TIER?.trim().toLowerCase();
  return tier === "free" || tier === "paid" ? tier : undefined;
}

/**
 * How a Gemini key is paid for, as the user declared it: Google's API does
 * not say whether a key's project has billing. A free-tier key costs
 * nothing; a paid one, or one not declared, is metered, so it is not used
 * without the user's express say.
 */
export function geminiBilling(tier: "free" | "paid" | undefined): Billing {
  switch (tier) {
    case "free":
      return { kind: "free-api", detail: "Gemini API free tier (as you declared it)" };
    case "paid":
      return { kind: "metered", detail: "A Gemini API key with billing" };
    default:
      return {
        kind: "metered",
        detail:
          "A Gemini API key of an undeclared tier (GEMINI_TIER=free when its project has no billing)",
      };
  }
}

/**
 * Gemini's authentication: the user's own Google AI Studio key, the
 * integration Google recommends for third-party agents (never a consumer
 * Google sign-in, never `agy`). Checking the key lists models, which
 * spends nothing.
 */
export class GeminiAuth implements ProviderAuth {
  readonly method = "api-key";
  readonly signIn =
    "Create a key at aistudio.google.com/apikey, then run `grafeno-agent login gemini` (or set GEMINI_API_KEY).";

  constructor(
    private readonly credential: GeminiCredential,
    private readonly settings: GeminiSettings,
  ) {}

  async status(): Promise<ProviderStatus> {
    const found = await this.credential.read();
    if (!found) return { installed: true, signedIn: false, detail: this.signIn };
    const env = this.settings.env ?? process.env;
    const tier = geminiTier(env);
    let answer: Response | undefined;
    try {
      answer = await (this.settings.fetch ?? fetch)(
        `${this.settings.api ?? GEMINI_API}/models?pageSize=1`,
        { headers: { "x-goog-api-key": found.key }, signal: AbortSignal.timeout(15_000) },
      );
    } catch {
      // Unreachable now: the key is not known to be wrong.
    }
    if (answer && [400, 401, 403].includes(answer.status)) {
      return {
        installed: true,
        signedIn: false,
        detail: `Google refused the Gemini key from ${found.from}. ${this.signIn}`,
      };
    }
    const billing = geminiBilling(tier);
    return {
      installed: true,
      signedIn: true,
      plan:
        tier === "free"
          ? "AI Studio (free tier)"
          : tier === "paid"
            ? "AI Studio (paid)"
            : "AI Studio",
      billing,
      detail: `Key from ${found.from}${answer ? "" : " (not checked: Google was not reachable)"}. ${billing.detail}.`,
    };
  }

  /** Google's API has no way to read a key's quota: the agent does not guess one. */
  usage(): Promise<ProviderUsage | undefined> {
    return Promise.resolve(undefined);
  }
}

interface GeminiModelInfo {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

/** Gemini's model selection: Google's `-latest` aliases by tier, and the models the key may use. */
export class GeminiCatalog implements ModelCatalog {
  readonly tiers = {
    deep: ["gemini-pro-latest", "gemini-flash-latest"],
    standard: ["gemini-flash-latest"],
    light: ["gemini-flash-lite-latest", "gemini-flash-latest"],
  } as const;
  readonly #names = new Map<string, string>();

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly settings: GeminiSettings,
  ) {}

  async models(): Promise<readonly ModelOption[]> {
    const key = await this.key();
    let found: GeminiModelInfo[] = [];
    if (key) {
      try {
        const answer = await (this.settings.fetch ?? fetch)(
          `${this.settings.api ?? GEMINI_API}/models?pageSize=1000`,
          { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20_000) },
        );
        if (answer.ok)
          found = ((await answer.json()) as { models?: GeminiModelInfo[] }).models ?? [];
      } catch {
        // Listed again next time.
      }
    }
    const usable = found.filter(
      (m) =>
        m.name?.startsWith("models/gemini") &&
        (m.supportedGenerationMethods ?? []).includes("generateContent"),
    );
    for (const m of usable) {
      if (m.name && m.displayName) this.#names.set(m.name.slice(7), m.displayName);
    }
    return [
      { id: "default", name: "Auto", hint: `the newest Flash (${AUTO_MODEL})` },
      ...usable.map((m) => ({
        id: (m.name ?? "").slice(7),
        name: m.displayName ?? (m.name ?? "").slice(7),
        ...(m.description ? { hint: m.description } : {}),
      })),
    ];
  }

  /** Gemini 3 and the `-latest` aliases take a thinking level. */
  efforts(model?: string): readonly string[] {
    if (model === undefined || model === "default") return ["low", "high"];
    return /^gemini-([3-9]|\d{2,})|-latest$/.test(model) ? ["low", "high"] : [];
  }

  modelName(id: string): string {
    return this.#names.get(id) ?? geminiModelName(id);
  }
}

/** `gemini-3-pro-preview` → "Gemini 3 Pro Preview". */
export function geminiModelName(id: string): string {
  return id
    .replace(/^models\//, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Gemini's execution: `generateContent`, with the agent's tools as functions. */
export class GeminiRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: false,
    // A turn that fails leaves the conversation as it was.
    keepsConversation: true,
    // Google's API does not report a key's quota.
    usageReport: false,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly settings: GeminiSettings,
  ) {}

  create(choice: ModelChoice) {
    return resilient(
      new GeminiModel({
        model: choice.model === undefined || choice.model === "default" ? AUTO_MODEL : choice.model,
        ...(choice.effort === undefined ? {} : { effort: choice.effort }),
        key: this.key,
        ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
        ...(this.settings.api ? { api: this.settings.api } : {}),
      }),
    );
  }
}

/** Gemini through Google AI Studio's API and the user's own key: its three parts, as one provider. */
export class GeminiProvider extends ComposedProvider {
  constructor(settings: GeminiSettings = {}) {
    const credential = new GeminiCredential(settings);
    super("gemini", "Gemini (AI Studio)", {
      auth: new GeminiAuth(credential, settings),
      catalog: new GeminiCatalog(credential.key, settings),
      runtime: new GeminiRuntime(credential.key, settings),
    });
  }
}

/** Where the key is kept on this machine, for `login gemini`. */
export function geminiStore(env: Record<string, string | undefined> = process.env): SecretStore {
  return systemSecretStore(dataDir(env));
}
