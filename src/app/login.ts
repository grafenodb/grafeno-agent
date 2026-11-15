import { GEMINI_API } from "../model/gemini.js";
import { GEMINI_ACCOUNT, geminiBilling } from "../providers/gemini.js";
import type { SecretStore } from "../providers/secrets.js";

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
  readonly fetch?: typeof fetch;
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
  io.say("Use it with AGENT_PROVIDERS=claude-code,gemini (or auto).");
  return 0;
}

/** Removes the stored key and the declared tier. */
export async function geminiLogout(options: Omit<GeminiLoginOptions, "fetch">): Promise<number> {
  await options.store.delete(GEMINI_ACCOUNT).catch(() => undefined);
  options.saveSettings({ GEMINI_TIER: "" });
  options.io.say(`The Gemini key was removed from ${options.store.name}.`);
  return 0;
}
