import { billingRefusal } from "../../providers/billing.js";
import { PROVIDER_PROFILES, providerEnabled } from "../../providers/profiles.js";
import type { ProviderStatus } from "../../providers/types.js";

/**
 * What a connection is, from what it answered, never from its settings
 * alone (a key in the settings is not a working connection):
 * - `available`: switched on, installed, signed in, allowed to bill: usable now;
 * - `connected`: signed in, but held back (it bills per token, not allowed);
 * - `configured`: there, but not signed in (or its key not given);
 * - `unavailable`: switched off, or not installed / not reachable;
 * - `error`: asking it failed.
 */
export type ConnectionState = "available" | "connected" | "configured" | "unavailable" | "error";

export function connectionState(input: {
  readonly id: string;
  readonly status?: ProviderStatus;
  /** Why asking it failed, when it did. */
  readonly failed?: string;
  readonly env?: Record<string, string | undefined>;
}): { readonly state: ConnectionState; readonly why: string } {
  const env = input.env ?? process.env;
  if (input.failed !== undefined) return { state: "error", why: input.failed };
  if (!providerEnabled(input.id, env)) return { state: "unavailable", why: "switched off" };
  const status = input.status;
  if (!status) return { state: "unavailable", why: "not asked yet" };
  if (!status.installed) return { state: "unavailable", why: status.detail };
  if (!status.signedIn) return { state: "configured", why: status.detail };
  const refused = billingRefusal(input.id, status, env);
  if (refused) return { state: "connected", why: refused };
  return { state: "available", why: status.detail };
}

/** How a state is shown: a mark and a word, and a color beside them. */
export const STATE_LOOK: Readonly<
  Record<
    ConnectionState,
    { readonly mark: string; readonly tone: "success" | "warning" | "error" | "muted" }
  >
> = {
  available: { mark: "●", tone: "success" },
  connected: { mark: "◐", tone: "warning" },
  configured: { mark: "○", tone: "warning" },
  unavailable: { mark: "○", tone: "muted" },
  error: { mark: "✗", tone: "error" },
};

/** How a connection is reached, in a word. */
export function connectionType(id: string): string {
  const type = PROVIDER_PROFILES[id]?.connectionType;
  return type === "cli"
    ? "CLI"
    : type === "api-key"
      ? "API key"
      : type === "coding-plan"
        ? "plan"
        : type === "local"
          ? "local"
          : "unknown";
}
