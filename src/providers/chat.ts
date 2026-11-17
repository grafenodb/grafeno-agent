import { autoMode, isAuto } from "./index.js";
import { NO_MODEL, NoModelProvider } from "./none.js";
import { canonicalProvider, providerEnabled } from "./profiles.js";
import type { Provider } from "./types.js";

/**
 * The provider the chat starts with: never one switched off, and never
 * another than the one chosen in its place.
 * - specific mode (AGENT_MODE=specific, or a provider in AGENT_PROVIDERS):
 *   the first chosen, if it is switched on; "none" first: no model; one
 *   switched off: no model, said as such (the next one in the list is not
 *   used behind the user's back);
 * - Auto: the first switched on, else no model.
 */
export function chatProvider(
  providers: readonly Provider[],
  env: Record<string, string | undefined>,
): Provider {
  const setting = (env.AGENT_PROVIDERS ?? "").trim().toLowerCase();
  if (!autoMode(env)) {
    const first = isAuto(setting) ? "" : (setting.split(",")[0]?.trim() ?? "");
    if (first === NO_MODEL) return new NoModelProvider();
    if (first === "") {
      return new NoModelProvider(
        "No provider is chosen for the chat yet: choose one in /connect (or switch Auto on in /mode).",
      );
    }
    const named = providers.find((p) => p.id === canonicalProvider(first));
    if (named && providerEnabled(named.id, env)) return named;
    return new NoModelProvider(
      `${named?.name ?? first} is switched off, so no model is selected: nothing is sent to any provider. Switch it on, or choose another, in /connect.`,
    );
  }
  return (
    providers.find((p) => providerEnabled(p.id, env)) ??
    new NoModelProvider(
      "Every connection is switched off, so no model is selected. Switch one on in /connect.",
    )
  );
}
