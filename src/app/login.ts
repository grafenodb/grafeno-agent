import { GEMINI_API } from "../model/gemini.js";
import { GEMINI_ACCOUNT, geminiBilling } from "../providers/gemini.js";
import {
  checkOpenRouterKey,
  OPENROUTER_ACCOUNT,
  openRouterBilling,
} from "../providers/openrouter.js";
import type { SecretStore } from "../providers/secrets.js";
import { CLAUDE_API_ACCOUNT } from "../providers/claude-api.js";

export interface LoginIo {
  /** Asks for a line; `hidden`: what is typed is not shown. */
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  say(line: string): void;
}

export interface GeminiLoginOptions {
  readonly io: LoginIo;
  readonly store: SecretStore;
  /** Saves settings that are not secret (the tier) to the settings file. */
  readonly saveSettings: (values: Record<string, string>) => void;
  /** The providers General Auto includes now; the person may add this one. */
  readonly autoMembers?: readonly string[];
  readonly fetch?: typeof fetch;
}

/** The same options, for any provider reached with an API key. */
export type ApiKeyLoginOptions = GeminiLoginOptions;

/**
 * Asks whether General Auto may use this provider too (no by default):
 * Auto uses only what the person includes.
 */
async function askAuto(options: ApiKeyLoginOptions, id: string, name: string): Promise<void> {
  const members = options.autoMembers;
  if (!members || members.includes(id)) return;
  const answer = (await options.io.ask(`Include ${name} in Auto too? [y/N]: `)).trim();
  if (/^(y|yes|s|si|sí)$/i.test(answer)) {
    options.saveSettings({ AGENT_AUTO_PROVIDERS: [...members, id].join(",") });
    options.io.say(`Auto now includes ${name} (/connect, space, takes it out again).`);
  } else {
    options.io.say(`Auto does not include ${name}; /connect (space) adds it when you want.`);
  }
}

/**
 * Sets up Gemini: the user's AI Studio key, checked with a call that spends
 * nothing (listing models), kept in the system's secure store (never in
 * Grafeno, the settings file or a log), and the tier the user declares for
 * it, which decides whether it may be used without their say.
 */
export async function geminiLogin(options: GeminiLoginOptions): Promise<number> {
  const { io } = options;
  io.say("Gemini through Google AI Studio's API, with your own key.");
  io.say("Create one at https://aistudio.google.com/apikey (it is never stored in Grafeno).");
  const key = (await io.ask("Gemini API key: ", { hidden: true })).trim();
  if (!key) {
    io.say("No key given: nothing changed.");
    return 1;
  }
  let check: Response;
  try {
    check = await (options.fetch ?? fetch)(`${GEMINI_API}/models?pageSize=1`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    io.say("Google could not be reached to check the key: nothing changed.");
    return 1;
  }
  if (!check.ok) {
    io.say(`Google refused the key (HTTP ${String(check.status)}): nothing changed.`);
    return 1;
  }
  io.say("");
  io.say("Does this key's Google Cloud project have billing turned on?");
  io.say(
    "  free: no billing; the API's free quota, at no cost (Google may use the data to improve its products).",
  );
  io.say(
    "  paid: billing on; each request is charged. The agent then uses Gemini only if you allow it.",
  );
  const answer = (await io.ask("Tier [free/paid]: ")).trim().toLowerCase();
  const tier = answer === "free" || answer === "paid" ? answer : undefined;
  if (!tier) {
    io.say("Answer free or paid: nothing changed.");
    return 1;
  }
  await options.store.set(GEMINI_ACCOUNT, key);
  options.saveSettings({ GEMINI_TIER: tier });
  const billing = geminiBilling(tier);
  io.say("");
  io.say(`Saved in ${options.store.name}. ${billing.detail}.`);
  if (billing.kind === "metered") {
    io.say("It bills by consumption: the agent uses it only with AGENT_ALLOW_BILLING=gemini.");
  }
  await askAuto(options, "gemini", "Gemini");
  return 0;
}

/** Removes the stored key and the declared tier. */
export async function geminiLogout(options: Omit<GeminiLoginOptions, "fetch">): Promise<number> {
  await options.store.delete(GEMINI_ACCOUNT).catch(() => undefined);
  options.saveSettings({ GEMINI_TIER: "" });
  options.io.say(`The Gemini key was removed from ${options.store.name}.`);
  return 0;
}

/**
 * Sets up OpenRouter: the user's key, checked with OpenRouter's key
 * endpoint (which spends nothing) before it is kept, in the system's secure
 * store, never in Grafeno, the settings file or a log. Then which models it
 * may use: free ones only (never billed, the default), or paid ones, which
 * bill per token and run only with AGENT_ALLOW_BILLING=openrouter.
 */
export async function openRouterLogin(options: ApiKeyLoginOptions): Promise<number> {
  const { io } = options;
  io.say("OpenRouter, with your own API key.");
  io.say("Create one at https://openrouter.ai/settings/keys (it is never stored in Grafeno).");
  const key = (await io.ask("OpenRouter API key: ", { hidden: true })).trim();
  if (!key) {
    io.say("No key given: nothing changed.");
    return 1;
  }
  const checked = await checkOpenRouterKey(key, options.fetch ? { fetch: options.fetch } : {});
  if (!checked.ok) {
    io.say(`${checked.reason}: nothing changed.`);
    return 1;
  }
  const info = checked.info;
  const free = info.free_model_daily_requests;
  io.say("");
  io.say(
    `OpenRouter accepted the key${info.label ? ` (${info.label})` : ""}: ${
      info.is_free_tier ? "your account never bought credits" : "your account has bought credits"
    }.`,
  );
  if (free?.limit) {
    io.say(`Free models today: ${String(free.used ?? 0)} of ${String(free.limit)} requests used.`);
  }
  if (typeof info.limit === "number") {
    io.say(`This key's credit limit: ${String(info.usage ?? 0)} of ${String(info.limit)} used.`);
  }
  io.say("");
  io.say("Which models may the agent use with it?");
  io.say(
    "  free: only OpenRouter's free models (:free); never billed. Their providers may keep prompts.",
  );
  io.say("  all: paid models too, billed per token; only with AGENT_ALLOW_BILLING=openrouter.");
  const answer = (await io.ask("Models [free/all] (free): ")).trim().toLowerCase() || "free";
  if (answer !== "free" && answer !== "all") {
    io.say("Answer free or all: nothing changed.");
    return 1;
  }
  await options.store.set(OPENROUTER_ACCOUNT, key);
  options.saveSettings({ OPENROUTER_MODELS: answer });
  const billing = openRouterBilling(answer);
  io.say("");
  io.say(`Saved in ${options.store.name}. ${billing.detail}.`);
  if (billing.kind === "metered") {
    io.say("It bills per token: the agent uses it only with AGENT_ALLOW_BILLING=openrouter.");
  }
  await askAuto(options, "openrouter", "OpenRouter");
  return 0;
}

/** Removes the stored OpenRouter key and its choice of models. */
export async function openRouterLogout(
  options: Omit<ApiKeyLoginOptions, "fetch">,
): Promise<number> {
  await options.store.delete(OPENROUTER_ACCOUNT).catch(() => undefined);
  options.saveSettings({ OPENROUTER_MODELS: "" });
  options.io.say(`The OpenRouter key was removed from ${options.store.name}.`);
  return 0;
}

/** What claude-api's login needs besides the common options: the client SDK, to check the key. */
export interface ClaudeApiLoginOptions extends ApiKeyLoginOptions {
  readonly listModels: (key: string) => Promise<readonly { id: string }[]>;
  /** The providers the person already allowed to bill by consumption (AGENT_ALLOW_BILLING). */
  readonly allowedBilling: readonly string[];
}

/**
 * Sets up claude-api: the person's Anthropic API key, checked by listing
 * models (which spends nothing) before it is kept in the system's secure
 * store. The API bills per token: the person is asked, plainly, whether
 * the agent may use it (AGENT_ALLOW_BILLING); no is the default, and then
 * claude-api is never used.
 */
export async function claudeApiLogin(options: ClaudeApiLoginOptions): Promise<number> {
  const { io } = options;
  io.say("claude-api: Claude through the official Agent SDK, with your Anthropic API key.");
  io.say(
    "It bills per token to your Anthropic account. It is separate from your Claude subscription.",
  );
  const key = (await io.ask("Anthropic API key: ", { hidden: true })).trim();
  if (!key) {
    io.say("No key given: nothing changed.");
    return 1;
  }
  let models: readonly { id: string }[];
  try {
    models = await options.listModels(key);
  } catch (error) {
    const raw = (error as { status?: unknown } | null)?.status;
    const status = typeof raw === "number" ? raw : undefined;
    io.say(
      status === 401 || status === 403
        ? "Anthropic refused the key: nothing changed."
        : `The key could not be checked (${status === undefined ? "the API was not reachable" : `HTTP ${String(status)}`}): nothing changed.`,
    );
    return 1;
  }
  await options.store.set(CLAUDE_API_ACCOUNT, key);
  io.say(
    `Anthropic accepted the key (${String(models.length)} models). Saved in ${options.store.name}.`,
  );
  if (!options.allowedBilling.includes("claude-api")) {
    const answer = (await io.ask("Allow the agent to use it, billed per token? [y/N]: ")).trim();
    if (/^(y|yes|s|si|sí)$/i.test(answer)) {
      options.saveSettings({
        AGENT_ALLOW_BILLING: [...options.allowedBilling, "claude-api"].join(","),
      });
      io.say("Allowed (AGENT_ALLOW_BILLING includes claude-api).");
    } else {
      io.say("Not allowed: claude-api stays unused until AGENT_ALLOW_BILLING includes it.");
    }
  }
  await askAuto(options, "claude-api", "claude-api");
  return 0;
}

/** Removes the stored Anthropic API key. */
export async function claudeApiLogout(options: Omit<ApiKeyLoginOptions, "fetch">): Promise<number> {
  await options.store.delete(CLAUDE_API_ACCOUNT).catch(() => undefined);
  options.io.say(`The Anthropic API key was removed from ${options.store.name}.`);
  return 0;
}
