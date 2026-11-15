import type { Provider, ProviderStatus } from "./types.js";

/**
 * The providers the user expressly allowed to bill by consumption
 * (`AGENT_ALLOW_BILLING=gemini,codex`). Empty by default: a metered
 * provider is never used, not even as a fallback.
 */
export function billingAllowed(
  id: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.AGENT_ALLOW_BILLING ?? "")
    .split(",")
    .map((p) => p.trim())
    .includes(id);
}

/** Why a provider may not be used now because of how it bills; undefined when it may. */
export function billingRefusal(
  id: string,
  status: ProviderStatus,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (status.billing?.kind !== "metered" || billingAllowed(id, env)) return undefined;
  return `${status.billing.detail}: it bills by consumption, which the agent does not use without your express say (AGENT_ALLOW_BILLING=${id}).`;
}

/** Throws when a provider bills by consumption and the user did not allow it. */
export async function assertBillingAllowed(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const status = await provider.status().catch(() => undefined);
  const refusal = status ? billingRefusal(provider.id, status, env) : undefined;
  if (refusal) throw new Error(`${provider.name}: ${refusal}`);
}
