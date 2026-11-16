import { dataDir } from "../data-dir.js";
import { apiKeySpec, checkKey, keyAccount } from "../providers/api-key.js";
import { billingAllowed } from "../providers/billing.js";
import {
  KNOWN_PROVIDERS,
  autoMembers,
  isLocalProvider,
  localState,
  registerLocalConnections,
} from "../providers/index.js";
import {
  describeModel,
  discover,
  type Discovery,
  type LocalModel,
} from "../providers/local/discover.js";
import {
  checkEndpoint,
  localityText,
  resolveEndpoint,
  type Locality,
} from "../providers/local/endpoint.js";
import { localKeyAccount } from "../providers/local/provider.js";
import {
  LOCAL_KIND_INFO,
  freeConnectionId,
  loadLocalConnections,
  localConnectionsFile,
  removeLocalConnection,
  saveLocalConnection,
  type LocalConnection,
  type LocalKind,
} from "../providers/local/store.js";
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
  /** A local or self-hosted server: its address, where it is, and its models with what each can do. */
  readonly server?: {
    readonly url: string;
    readonly locality?: Locality;
    readonly version?: string;
    readonly defaultModel?: string;
    readonly models: readonly LocalModel[];
    readonly timeoutMs?: number;
    readonly inference?: LocalConnection["inference"];
  };
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

/** A local connection's record, with what its server says now (its models and their capabilities). */
export async function localConnectionRecord(
  provider: Provider,
  status: ProviderStatus,
  env: Record<string, string | undefined> = process.env,
): Promise<ConnectionRecord> {
  const record = connectionRecord(provider, status, env);
  const state = localState(provider.id);
  if (!state) return record;
  const found = await state.discovery();
  const where = await state.locality();
  const models = found.models;
  return {
    ...record,
    supportedModels: models.map((m) => m.id),
    // What the server says of its models: tools only when a model is known to take them.
    supportsTools: models.some((m) => m.tools === true),
    costModel: where === "local" ? "local" : "self-hosted",
    server: {
      url: state.connection.url,
      ...(typeof where === "string" ? { locality: where } : {}),
      ...(found.version ? { version: found.version } : {}),
      ...(state.connection.defaultModel ? { defaultModel: state.connection.defaultModel } : {}),
      models,
      ...(state.connection.timeoutMs ? { timeoutMs: state.connection.timeoutMs } : {}),
      ...(state.connection.inference ? { inference: state.connection.inference } : {}),
    },
  };
}

const TYPE_LABEL: Record<ConnectionType, string> = {
  cli: "CLI",
  "api-key": "API Key",
  "coding-plan": "Coding Plan",
  local: "Local",
};

/** A connection's state in a word or three: never "connected" for a program only installed. */
export function stateOf(record: ConnectionRecord): string {
  if (!record.enabled) return "Switched off";
  if (record.connectionType === "local") {
    if (!record.installed) return "Not running";
    if (!record.authenticated)
      return record.supportedModels.length === 0 ? "No model" : "Needs a key";
    return "Connected";
  }
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
      if (r.server) {
        for (const m of r.server.models.slice(0, 12)) {
          lines.push(
            `${" ".repeat(29)}${m.id === r.server.defaultModel ? "★ " : "· "}${m.id}  ${describeModel(m)}`,
          );
        }
        if (r.server.models.length > 12) {
          lines.push(`${" ".repeat(29)}… ${String(r.server.models.length - 12)} more`);
        }
      }
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
  /** The interface's list of providers: a local connection added or removed is changed in it too. */
  readonly providers?: Provider[];
  /** Where the local connections are kept. Default: next to the settings. */
  readonly localFile?: string;
  /** Resolves a server's name; for tests. */
  readonly resolve?: (host: string) => Promise<string[]>;
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
    /**
     * Checks a model server before it is kept: its address (never a
     * link-local one, a key only over https off this computer), where it
     * leads, and what it answers (its version and models, spending nothing).
     */
    async checkServer(
      kind: LocalKind,
      url: string,
      key?: string,
    ): Promise<
      | { ok: true; url: string; locality: Locality; found: Discovery }
      | { ok: false; message: string; needsKey?: boolean }
    > {
      const withKey = key !== undefined && key.trim() !== "";
      const checked = checkEndpoint(url, { withKey });
      if (!checked.ok) return { ok: false, message: `${url}: ${checked.reason}.` };
      const resolved = await resolveEndpoint(checked, options.resolve);
      if (!resolved.ok) return { ok: false, message: `${url}: ${resolved.reason}.` };
      const found = await discover(
        { id: "check", kind, name: LOCAL_KIND_INFO[kind].name, url: resolved.url },
        {
          ...(withKey ? { key: key.trim() } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        },
      );
      if (!found.reachable) {
        return {
          ok: false,
          message: `${LOCAL_KIND_INFO[kind].name} at ${resolved.url}: ${found.error ?? "no answer"}.`,
        };
      }
      if (found.needsKey) {
        return {
          ok: false,
          needsKey: true,
          message: `${LOCAL_KIND_INFO[kind].name} at ${resolved.url}: ${found.error ?? "asks for a key"}.`,
        };
      }
      return { ok: true, url: resolved.url, locality: resolved.locality, found };
    },
    /**
     * Keeps a model server: its address and default model in the
     * connections' list, its key (when it has one) in the system's secure
     * store; it is a provider at once. Returns what to say.
     */
    async saveServer(server: {
      readonly kind: LocalKind;
      readonly url: string;
      readonly id?: string;
      readonly key?: string;
      readonly defaultModel?: string;
      readonly locality?: Locality;
    }): Promise<{ id: string; message: string }> {
      const file = options.localFile ?? localConnectionsFile(options.env);
      const all = loadLocalConnections(file);
      const taken = [
        ...all.map((c) => c.id),
        ...Object.keys(KNOWN_PROVIDERS).filter((id) => !isLocalProvider(id)),
      ];
      // The same server added again (same kind and address) is the connection it was, not a second one.
      const same = all.find(
        (c) => c.kind === server.kind && c.url === server.url.replace(/\/+$/, ""),
      );
      const id = server.id ?? same?.id ?? freeConnectionId(server.kind, taken);
      const before = all.find((c) => c.id === id);
      const withKey = server.key !== undefined && server.key.trim() !== "";
      const info = LOCAL_KIND_INFO[server.kind];
      const entry = saveLocalConnection(
        {
          ...before,
          id,
          kind: server.kind,
          name: id === server.kind || id === "custom" ? info.name : `${info.name} (${id})`,
          url: server.url,
          ...(server.defaultModel ? { defaultModel: server.defaultModel } : {}),
          ...(withKey || before?.hasKey ? { hasKey: true } : {}),
        },
        file,
      );
      if (withKey) await store().set(localKeyAccount(id), (server.key ?? "").trim());
      this.refreshLocal(file);
      return {
        id,
        message: `${entry.name} is connected at ${entry.url}${server.locality ? ` (${localityText(server.locality)})` : ""}${
          entry.defaultModel ? `, default model ${entry.defaultModel}` : ""
        }${withKey ? `; its key is in ${store().name}` : ""}. /connect local uses it for the chat or in Auto.`,
      };
    },
    /** Sets the model a local connection uses when none is chosen. */
    setServerModel(id: string, model: string): string {
      const file = options.localFile ?? localConnectionsFile(options.env);
      const found = loadLocalConnections(file).find((c) => c.id === id);
      if (!found) return `No local connection is named ${id}.`;
      saveLocalConnection({ ...found, defaultModel: model }, file);
      this.refreshLocal(file);
      return `${found.name} uses ${model} by default.`;
    },
    /** Removes a local connection and its key; a built-in one goes back to its documented address. */
    async removeServer(id: string): Promise<string> {
      const file = options.localFile ?? localConnectionsFile(options.env);
      const found = loadLocalConnections(file).find((c) => c.id === id);
      if (!found || !removeLocalConnection(id, file)) return `No local connection is named ${id}.`;
      await store()
        .delete(localKeyAccount(id))
        .catch(() => undefined);
      this.refreshLocal(file);
      return id === "ollama" || id === "lmstudio"
        ? `${found.name} is back at its documented address (${String(LOCAL_KIND_INFO[found.kind].defaultUrl)}), with no default model or key.`
        : `${found.name} is removed${found.hasKey ? `, its key too` : ""}.`;
    },
    /** Registers the local connections again, and changes them in the interface's list of providers. */
    refreshLocal(file = options.localFile ?? localConnectionsFile(options.env)): void {
      const before = new Set(
        (options.providers ?? []).filter((p) => isLocalProvider(p.id)).map((p) => p.id),
      );
      const ids = registerLocalConnections(loadLocalConnections(file));
      if (!options.providers) return;
      const list = options.providers;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (p && before.has(p.id)) list.splice(i, 1);
      }
      for (const id of ids) {
        const make = KNOWN_PROVIDERS[id];
        if (make) list.push(make());
      }
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
