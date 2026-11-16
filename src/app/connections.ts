import { dataDir } from "../data-dir.js";
import { apiKeySpec, checkKey, keyAccount } from "../providers/api-key.js";
import { billingAllowed } from "../providers/billing.js";
import { autoMembers } from "../providers/index.js";
import {
  PROVIDER_PROFILES,
  providerEnabled,
  switchVariables,
  type ConnectionType,
} from "../providers/profiles.js";
import { systemSecretStore, type SecretStore } from "../providers/secrets.js";
import type { Provider, ProviderStatus } from "../providers/types.js";

/** A connection in the registry: what it is, and how it stands now. */
export interface ConnectionRecord {
  readonly providerId: string;
  readonly providerName: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly connectionType: ConnectionType;
  readonly authMethod: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly authenticated: boolean;
  /** On, installed, signed in, and (when billed per token) allowed. */
  readonly available: boolean;
  readonly supportedModels: readonly string[];
  readonly supportsStreaming: boolean;
  readonly supportsSessions: boolean;
  readonly supportsTools: boolean;
  readonly supportsMCP: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsHeadless: boolean;
  readonly usageLimits?: string;
  readonly costModel: string;
  readonly complianceStatus: string;
  readonly inAuto: boolean;
  readonly detail: string;
}

/** A connection's record, from its profile and its live status. */
export function connectionRecord(
  provider: Provider,
  status: ProviderStatus,
  env: Record<string, string | undefined> = process.env,
): ConnectionRecord {
  const profile = PROVIDER_PROFILES[provider.id];
  const enabled = providerEnabled(provider.id, env);
  const metered = status.billing?.kind === "metered";
  const authenticated = enabled && status.signedIn;
  let auto: string[];
  try {
    auto = autoMembers(env);
  } catch {
    auto = [];
  }
  return {
    providerId: profile?.vendor ?? provider.id,
    providerName: profile?.vendorName ?? provider.name,
    connectionId: profile?.shownAs ?? provider.id,
    displayName: provider.name,
    connectionType: profile?.connectionType ?? "api-key",
    authMethod: profile?.auth ?? provider.parts?.auth.method ?? "?",
    enabled,
    installed: status.installed,
    authenticated,
    available:
      enabled &&
      status.installed &&
      status.signedIn &&
      (!metered || billingAllowed(provider.id, env)),
    supportedModels: [],
    supportsStreaming: profile?.supports.streaming ?? provider.features?.streaming ?? false,
    supportsSessions: profile?.supports.sessions ?? true,
    supportsTools: profile?.supports.tools ?? true,
    supportsMCP: profile?.supports.mcp ?? true,
    supportsCancellation: profile?.supports.cancellation ?? true,
    supportsHeadless: profile?.supports.headless ?? true,
    costModel: metered ? "metered" : (profile?.costModel ?? "unknown"),
    complianceStatus: profile?.compliance ?? "documented",
    inAuto: auto.includes(provider.id),
    detail: status.detail,
  };
}

const TYPE_LABEL: Record<ConnectionType, string> = {
  cli: "CLI",
  "api-key": "API Key",
  "coding-plan": "Coding Plan",
};

/** A connection's state in a word or three: never "connected" for a program only installed. */
export function stateOf(record: ConnectionRecord): string {
  if (!record.enabled) return "Switched off";
  if (!record.installed)
    return record.connectionType === "cli" ? "Not installed" : "Not configured";
  if (!record.authenticated) {
    return record.connectionType === "cli" ? "Installed, not signed in" : "Not configured";
  }
  if (!record.available) return "Connected, billing not allowed";
  return "Connected";
}

/** The connections as a table for a person: vendor, method, state. */
export function describeConnections(
  records: readonly ConnectionRecord[],
  detailed = false,
): string[] {
  const lines = [
    `${"Provider".padEnd(26)} ${"Connection".padEnd(20)} ${"Method".padEnd(12)} State`,
  ];
  for (const r of records) {
    lines.push(
      `${r.providerName.slice(0, 25).padEnd(26)} ${r.connectionId.slice(0, 19).padEnd(20)} ${TYPE_LABEL[r.connectionType].padEnd(12)} ${stateOf(r)}${r.inAuto ? " · in Auto" : ""}`,
    );
    if (detailed) {
      lines.push(`${" ".repeat(27)}${r.detail}`);
      if (r.complianceStatus !== "documented") {
        lines.push(`${" ".repeat(27)}Terms: ${complianceText(r.complianceStatus)}`);
      }
    }
  }
  return lines;
}

/** What a compliance status means, in a sentence. */
export function complianceText(status: string): string {
  switch (status) {
    case "pending-anthropic-review":
      return "using a Claude subscription in a third-party orchestrator awaits Anthropic's answer; not approved or certified by Anthropic.";
    case "restricted-supported-tools":
      return "the vendor limits this key to the coding tools it lists, and this agent is not one of them.";
    case "unverified":
      return "the vendor's terms do not say whether a third-party agent may use it.";
    default:
      return "documented interface, used as documented.";
  }
}

export interface ConnectionActions {
  readonly env: Record<string, string | undefined>;
  /** Saves settings to the settings file and to this run. */
  readonly save: (values: Record<string, string>) => void;
  readonly store?: SecretStore;
  readonly fetch?: typeof fetch;
}

/**
 * What /connect does to connections, outside the interface: keys checked
 * and kept in the system's secure store, switches, billing, disconnecting.
 */
export function connectionActions(options: ConnectionActions) {
  const store = () => options.store ?? systemSecretStore(dataDir(options.env));
  return {
    /** Checks a key with its vendor (free) and keeps it; says what happened. */
    async setKey(id: string, key: string): Promise<{ ok: boolean; message: string }> {
      const spec = apiKeySpec(id);
      if (!spec) return { ok: false, message: `${id} is not a connection by key.` };
      const trimmed = key.trim();
      if (trimmed === "") return { ok: false, message: "No key given: nothing changed." };
      const checked = await checkKey(spec, trimmed, {
        env: options.env,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (!checked.ok && checked.refused)
        return { ok: false, message: `${checked.reason}: nothing changed.` };
      await store().set(keyAccount(spec.id), trimmed);
      return {
        ok: true,
        message: checked.ok
          ? `${spec.name} accepted the key (${String(checked.models.length)} models); kept in ${store().name}.`
          : `Kept in ${store().name}, though not checked: ${checked.reason}.`,
      };
    },
    /** Removes a connection's key: disconnected, its settings kept. */
    async disconnect(id: string): Promise<string> {
      const spec = apiKeySpec(id);
      if (!spec) {
        const profile = PROVIDER_PROFILES[id];
        return profile?.connectionType === "cli"
          ? `${profile.shownAs} signs in with its own program: sign out there. Switch it off here to stop using it.`
          : `${id} keeps its key elsewhere: grafeno-agent logout ${id}.`;
      }
      await store()
        .delete(keyAccount(spec.id))
        .catch(() => undefined);
      return `${spec.name} is disconnected: its key was removed from ${store().name}.`;
    },
    /** Switches a connection on or off, at once. */
    setEnabled(id: string, on: boolean): string {
      options.save(Object.fromEntries(switchVariables(id).map((n) => [n, on ? "true" : "false"])));
      const shown = PROVIDER_PROFILES[id]?.shownAs ?? id;
      return on
        ? `${shown} is switched on.`
        : `${shown} is switched off: nothing uses it, starting now.`;
    },
    /** Allows or forbids a connection to bill per token (AGENT_ALLOW_BILLING). */
    setBilling(id: string, allow: boolean): string {
      const now = (options.env.AGENT_ALLOW_BILLING ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const next = allow ? [...new Set([...now, id])] : now.filter((p) => p !== id);
      options.save({ AGENT_ALLOW_BILLING: next.join(",") });
      return allow
        ? `${id} may bill per token now (AGENT_ALLOW_BILLING).`
        : `${id} may no longer bill per token: it is not used.`;
    },
  };
}

export type ConnectionActionsApi = ReturnType<typeof connectionActions>;
