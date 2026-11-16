import type { Model } from "../model/index.js";

/** Whether a provider can be used here, and as whom. */
export interface ProviderStatus {
  /** Its program or access is there. */
  readonly installed: boolean;
  /** It is signed in (or has its key). */
  readonly signedIn: boolean;
  /** Its version, when it has one. */
  readonly version?: string;
  /** The plan or account kind, such as "Claude Pro" (never an e-mail or a secret). */
  readonly plan?: string;
  /** What to do next, or what is fine, in a sentence. */
  readonly detail: string;
  /** How what it answers is paid for, once it is signed in. */
  readonly billing?: Billing;
}

/**
 * How a provider's answers are paid for. The agent keeps the three apart and
 * never uses a metered one without the user's express say (AGENT_ALLOW_BILLING).
 */
export type BillingKind =
  /** A plan paid for anyway (Claude Pro, ChatGPT Plus): it spends the plan's quota. */
  | "subscription"
  /** An API's free quota: no charge, with its own limits. */
  | "free-api"
  /** Billed by consumption (tokens): only with the user's express authorization. */
  | "metered"
  /** A model server of the user's own (on this computer or theirs): no one bills per token. */
  | "local";

export interface Billing {
  readonly kind: BillingKind;
  /** In a sentence: "Your Claude Pro plan", "Gemini API free tier"… */
  readonly detail: string;
}

/** A model a provider offers. */
export interface ModelOption {
  /** What the provider is given to use it (an alias or an id). */
  readonly id: string;
  /** Its exact name, as the provider writes it: "Opus 5.5". */
  readonly name: string;
  readonly hint?: string;
}

/** One of the provider's usage limits, as it reports it. */
export interface UsageLimit {
  /** "Session", "Week (all models)"… */
  readonly label: string;
  /** Used, from 0 to 1. */
  readonly used: number;
  /** When it starts again, as the provider says it. */
  readonly resets?: string;
}

/** The provider's real usage of the user's plan or account. */
export interface ProviderUsage {
  readonly limits: readonly UsageLimit[];
  /** A line about how it is paid for, when the provider says. */
  readonly note?: string;
  readonly at: Date;
}

/** Which model, and how hard it thinks. */
export interface ModelChoice {
  /** Undefined: the provider's own default. */
  readonly model?: string;
  readonly effort?: string;
}

/** What a provider's adapter can do, as it declares it (the registry verifies the rest). */
export interface ProviderFeatures {
  /** The agent's tools reach it (over MCP); it never uses its own. */
  readonly agentTools: boolean;
  /** It streams events while it works. */
  readonly streaming: boolean;
  /** A cancelled turn leaves the conversation able to go on. */
  readonly keepsConversation: boolean;
  /** It reports the plan's real usage without spending any. */
  readonly usageReport: boolean;
  /** It runs without a person at a terminal. */
  readonly nonInteractive: boolean;
}

/**
 * Authentication: who the provider answers as, and that account's state
 * (sign-in, billing, usage). Credentials stay under the provider's control
 * (its own program) or in the system's secure store; never in Grafeno.
 */
export interface ProviderAuth {
  /**
   * `provider-cli`: the provider's official program holds the sign-in;
   * `api-key`: a key of the user's; `local-server`: a model server of the
   * user's own, with a key only when it asks for one.
   */
  readonly method: "provider-cli" | "api-key" | "local-server";
  /** How to sign in, in a sentence. */
  readonly signIn: string;
  status(): Promise<ProviderStatus>;
  /** The real usage of the account, without spending any; undefined when it cannot say. `fresh`: not a recent reading. */
  usage(options?: { fresh?: boolean }): Promise<ProviderUsage | undefined>;
}

/** Model selection: what the provider offers, and how tiers map to it. */
export interface ModelCatalog {
  readonly tiers: Readonly<Record<"deep" | "standard" | "light", readonly string[]>>;
  models(): Promise<readonly ModelOption[]>;
  efforts(model?: string): readonly string[];
  modelName(id: string): string;
}

/** Execution: a model to reason with, and what the adapter can do. */
export interface ProviderRuntime {
  readonly features: ProviderFeatures;
  create(choice: ModelChoice): Model;
}

/** A provider as its three separate parts. */
export interface ProviderParts {
  readonly auth: ProviderAuth;
  readonly catalog: ModelCatalog;
  readonly runtime: ProviderRuntime;
}

/**
 * Where the reasoning comes from: Claude through Claude Code, Codex through
 * the Codex CLI, others later. Each says whether it is ready, which models and efforts
 * it has, and how much of the user's plan is used.
 */
export interface Provider {
  readonly id: string;
  /** "Claude (Claude Code)". */
  readonly name: string;
  status(): Promise<ProviderStatus>;
  models(): Promise<readonly ModelOption[]>;
  /** The efforts it takes, lowest first; empty when it has none. */
  efforts(model?: string): readonly string[];
  /**
   * The real usage of the plan, without spending any; undefined when it
   * cannot say. It may be a reading of the last minute (its `at` says
   * when); `fresh` asks the provider anew.
   */
  usage(options?: { fresh?: boolean }): Promise<ProviderUsage | undefined>;
  /** The exact name of a model from its id: `claude-opus-5-5` → "Opus 5.5". */
  modelName(id: string): string;
  /** A model to reason with. */
  create(choice: ModelChoice): Model;
  /** How to sign in, in a sentence. */
  readonly signIn: string;
  /**
   * For each capability tier, its models in order of preference (ids or
   * aliases of `models()`): how the orchestrator maps "deep", "standard"
   * and "light" to this provider without naming models anywhere else.
   */
  readonly tiers?: Readonly<Record<"deep" | "standard" | "light", readonly string[]>>;
  /** What its adapter can do. */
  readonly features?: ProviderFeatures;
  /** Its authentication, model selection and execution, kept apart (when it is built from them). */
  readonly parts?: ProviderParts;
}
