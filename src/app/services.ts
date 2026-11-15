import { existsSync } from "node:fs";
import { connectAll } from "../mcp/client.js";
import { loadMcpConfig, mcpConfigPath } from "../mcp/config.js";
import { connectPlugins } from "../plugins/index.js";
import { PERMISSIONS_SETTING, type PermissionMode } from "../agent/permissions.js";
import { billingRefusal } from "../providers/billing.js";
import type { Tool } from "../agent/tools.js";
import { assertBillingAllowed } from "../providers/billing.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, INCLUDED_GRAFENO_URL, loadConfig, type Config } from "../config.js";
import { LOCAL_MODELS, loadTransformers, localEmbedder } from "../embed/local.js";
import type { Embedder } from "../embed/types.js";
import {
  includedAsset,
  includedInstalled,
  installIncluded,
  makeAgentKey,
  newOwnerToken,
  startIncluded,
  stopIncluded,
} from "../grafeno/included.js";
import { describeUpkeep, upkeep } from "../memory/upkeep.js";
import { allProviders, autoMembers } from "../providers/index.js";
import { lightModel, mostRoom, triage, type PoolMember, type TriageDecision } from "./triage.js";
import type { ModelChoice, Provider } from "../providers/types.js";
import { settingsPath, updateSettings } from "../settings-file.js";
import { checkGrafeno } from "../startup.js";
import { AgentSession, type SessionExtensions } from "./session.js";
import type { Orchestrator, OrchestratorOptions } from "../orchestrator/orchestrator.js";

/** What the interface shows about the Grafeno the agent uses. */
export interface GrafenoInfo {
  readonly mode: "included" | "external";
  readonly url: string;
  readonly namespace: string;
  readonly hasKey: boolean;
  /** This computer has a build of Grafeno to include. */
  readonly includable: boolean;
  /** The included Grafeno is installed here. */
  readonly installed: boolean;
}

/** A Grafeno server the user already has. */
export interface ServerValues {
  readonly url: string;
  /** A new key; absent to keep the one in the settings. */
  readonly key?: string;
  readonly namespace: string;
}

/** What the interface needs from the rest of the program. */
/** A Grafeno found running on this computer. */
export interface LocalGrafeno {
  readonly url: string;
  readonly version: string;
}

/** Whether a Grafeno answers at a URL, and its version: one short /health. */
export async function probeGrafeno(
  url: string,
  doFetch: typeof fetch = fetch,
): Promise<LocalGrafeno | undefined> {
  try {
    const response = await doFetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const health = (await response.json()) as { status?: unknown; version?: unknown };
    return typeof health.version === "string" ? { url, version: health.version } : undefined;
  } catch {
    return undefined;
  }
}

export interface AppServices {
  readonly version: string;
  readonly settingsPath: string;
  /** Where the reasoning can come from: Claude today, more later. */
  readonly providers: readonly Provider[];
  /**
   * Where the memory lives has not been chosen yet (or it cannot work as
   * set): the interface asks first.
   */
  needsSetup(): boolean;
  /**
   * A Grafeno already running on this computer (at the settings' address,
   * else 127.0.0.1:7810), with its version; nothing when none answers. The
   * agent's own (included) Grafeno is not it.
   */
  findLocalGrafeno?(): Promise<LocalGrafeno | undefined>;
  /**
   * Starts a session with the settings as they are; throws saying why it
   * cannot. `tools`: tools the interface adds (such as `delegate`).
   */
  start(extra?: { readonly tools?: readonly Tool[] }): Promise<AgentSession>;
  grafeno(): GrafenoInfo;
  /** Installs and starts the included Grafeno, makes the agent's key and saves it all. */
  includeGrafeno(onProgress?: (done: number, total: number) => void): Promise<string>;
  /** Checks a Grafeno server the user already has, and saves it. */
  connectGrafeno(values: ServerValues): Promise<string>;
  /** Stops the included Grafeno, in a line. */
  stopGrafeno(): string;
  /** Keeps the model, effort, provider and Auto's providers chosen, for the next sessions. */
  saveChoice(choice: {
    model?: string;
    effort?: string;
    provider?: string;
    /** The providers General Auto includes, in order. */
    autoProviders?: readonly string[];
    /** The agent-wide permission mode (AGENT_PERMISSIONS). */
    permissions?: PermissionMode;
  }): void;
  /** The memory upkeep report for the session's project. */
  upkeep(session: AgentSession): Promise<string>;
  /**
   * An orchestrator for the project, on the settings, wired to the
   * interface; `auto`: General Auto, every ready provider as one pool.
   */
  orchestrator(extra: Partial<OrchestratorOptions>, auto?: boolean): Promise<Orchestrator>;
  /** The providers that are ready now (installed, signed in), each with its usage. */
  pool(): Promise<PoolMember[]>;
  /** General Auto's triage of a message: answer directly, or orchestrate. */
  triage(message: string, signal?: AbortSignal): Promise<TriageDecision>;
}

/** The embedder the settings name, when it can run here; `say` tells the user what happens. */
export async function embedderFor(
  name: string,
  say: (text: string) => void = console.log,
): Promise<Embedder | undefined> {
  if (name !== "e5-small") return undefined;
  try {
    await loadTransformers();
  } catch {
    say(
      "Meaning is off: @huggingface/transformers is not installed, so memory works by words alone.",
    );
    return undefined;
  }
  const model = LOCAL_MODELS["e5-small"].id.split("/");
  if (!existsSync(join(homedir(), ".cache", "grafeno-agent", "models", ...model))) {
    say("The meaning model is downloaded once, on first use (about 130 MB).");
  }
  return localEmbedder("e5-small");
}

/** Starts the included Grafeno when the settings use it; nothing otherwise. */
export async function prepareGrafeno(config: Config, env = process.env): Promise<void> {
  if (config.grafenoMode !== "included") return;
  const owner = env.GRAFENO_OWNER_TOKEN?.trim();
  if (!owner) throw new Error("The included Grafeno has no owner token yet: /palace sets it up.");
  await startIncluded(owner);
}

/**
 * The external MCP servers of mcp.json and the plugins turned on,
 * connected: their tools for the agent, and for the session what to tell
 * the person and what to close.
 */
async function connectExtensions(
  env: Record<string, string | undefined>,
  version: string,
  root: string,
): Promise<{ tools: Tool[]; session: SessionExtensions }> {
  const config = loadMcpConfig(mcpConfigPath(env));
  const [connections, plugins] = await Promise.all([
    connectAll(config.servers, { env, version }),
    connectPlugins(env, root),
  ]);
  const notes = [
    ...config.problems.map((p) => `MCP: ${p}`),
    ...connections.flatMap((c) => [
      ...(c.error ? [`MCP server ${c.name} was not reached: ${c.error}`] : []),
      ...(c.missing.length > 0
        ? [`MCP server ${c.name}: ${[...new Set(c.missing)].join(", ")} not set in the environment`]
        : []),
    ]),
    ...plugins.notes,
  ];
  return {
    tools: [...connections.flatMap((c) => [...c.tools]), ...plugins.tools],
    session: {
      notes,
      plugins: plugins.states,
      mcp: connections.map((c) => ({
        name: c.name,
        tools: c.tools.length,
        ...(c.error ? { error: c.error } : {}),
      })),
      close: async () => {
        await Promise.all(connections.map((c) => c.close()));
      },
    },
  };
}

/** The interface's services, on the real settings, Grafeno and providers. */
export function realServices(version: string): AppServices {
  let embedder: Promise<Embedder | undefined> | undefined;
  const env = process.env;
  // Every known provider, the chosen ones (AGENT_PROVIDERS) first: the chat uses the first.
  const providers: Provider[] = allProviders(env);

  /** The providers General Auto includes (AGENT_AUTO_PROVIDERS), as the user chose them. */
  const inAuto = (): Provider[] => {
    const ids = autoMembers(env);
    return providers.filter((p) => ids.includes(p.id));
  };

  /** The ready providers, read at most once a minute: statuses and usage are slow to ask. */
  let pooled: { at: number; members: Promise<PoolMember[]> } | undefined;
  const readyPool = (all: readonly Provider[]): Promise<PoolMember[]> => {
    if (pooled && Date.now() - pooled.at < 60_000) return pooled.members;
    const members = (async () => {
      const found = await Promise.all(
        all.map(async (provider) => {
          const status = await provider.status().catch(() => undefined);
          if (!status?.installed || !status.signedIn) return undefined;
          // Billed per token without the user's express say: never in the pool.
          if (billingRefusal(provider.id, status, env)) return undefined;
          const usage = await provider.usage().catch(() => undefined);
          return { provider, ...(usage ? { usage } : {}) };
        }),
      );
      return found.filter((m): m is PoolMember => m !== undefined);
    })();
    pooled = { at: Date.now(), members };
    return members;
  };

  /** Saves settings to the file and to this run. */
  const save = (values: Record<string, string>) => {
    updateSettings(values);
    for (const [name, value] of Object.entries(values)) {
      if (value === "") Reflect.deleteProperty(env, name);
      else env[name] = value;
    }
  };

  return {
    version,
    settingsPath: settingsPath(),
    providers,
    needsSetup() {
      const mode = env.GRAFENO_MODE?.trim();
      // Not chosen yet: a Grafeno of the user's own or the agent's own is a question.
      if (!mode) return true;
      if (mode === "included") return !env.GRAFENO_OWNER_TOKEN?.trim() || !includedInstalled();
      return !env.GRAFENO_AGENT_KEY?.trim();
    },
    async findLocalGrafeno() {
      const candidates = [
        ...new Set(
          [env.GRAFENO_URL?.trim(), DEFAULTS.grafenoUrl]
            .filter((url): url is string => Boolean(url))
            .map((url) => url.replace(/\/+$/, ""))
            .filter((url) => url !== INCLUDED_GRAFENO_URL),
        ),
      ];
      for (const url of candidates) {
        const found = await probeGrafeno(url);
        if (found) return found;
      }
      return undefined;
    },
    async start(extra) {
      const config = loadConfig();
      await prepareGrafeno(config);
      const report = await checkGrafeno(config);
      embedder ??= embedderFor(config.embedder, () => undefined);
      const chosen = await embedder;
      // A provider that bills by consumption is not used without the user's express say.
      await assertBillingAllowed(providers[0] as Provider, env);
      // External MCP servers and plugins: their tools join the agent's; one not reached is said.
      const extensions = await connectExtensions(env, version, process.cwd());
      const tools = [...(extra?.tools ?? []), ...extensions.tools];
      return AgentSession.start({
        config,
        provider: providers[0] as Provider,
        ...(tools.length > 0 ? { extraTools: tools } : {}),
        extensions: extensions.session,
        ...(report.identity ? { identity: report.identity } : {}),
        ...(chosen ? { embedder: chosen } : {}),
      });
    },
    grafeno() {
      const included = env.GRAFENO_MODE?.trim() === "included";
      return {
        mode: included ? "included" : "external",
        url: included ? INCLUDED_GRAFENO_URL : env.GRAFENO_URL?.trim() || DEFAULTS.grafenoUrl,
        namespace: env.GRAFENO_NAMESPACE?.trim() || DEFAULTS.namespace,
        hasKey: (env.GRAFENO_AGENT_KEY?.trim() ?? "") !== "",
        includable: includedAsset() !== undefined,
        installed: includedInstalled(),
      };
    },
    async includeGrafeno(onProgress) {
      await installIncluded(onProgress ? { onProgress } : {});
      const owner = env.GRAFENO_OWNER_TOKEN?.trim() || newOwnerToken();
      const url = await startIncluded(owner);
      const namespace = env.GRAFENO_NAMESPACE?.trim() || DEFAULTS.namespace;
      const key = await makeAgentKey(url, owner, namespace);
      save({
        GRAFENO_MODE: "included",
        GRAFENO_OWNER_TOKEN: owner,
        GRAFENO_AGENT_KEY: key,
        GRAFENO_NAMESPACE: namespace,
      });
      return `Grafeno is included and running at ${url}, namespace "${namespace}". Saved in ${settingsPath()}.`;
    },
    async connectGrafeno(values) {
      const candidate = loadConfig({
        ...env,
        GRAFENO_MODE: "external",
        GRAFENO_URL: values.url,
        GRAFENO_NAMESPACE: values.namespace,
        ...(values.key === undefined ? {} : { GRAFENO_AGENT_KEY: values.key }),
      });
      const report = await checkGrafeno(candidate);
      save({
        GRAFENO_MODE: "external",
        GRAFENO_URL: candidate.grafenoUrl,
        GRAFENO_NAMESPACE: candidate.namespace,
        ...(values.key === undefined ? {} : { GRAFENO_AGENT_KEY: candidate.agentKey }),
      });
      const who = report.identity ? ` as "${report.identity.name}"` : "";
      return `Connected to Grafeno ${report.serverVersion} at ${candidate.grafenoUrl}, namespace "${candidate.namespace}"${who}. Saved in ${settingsPath()}.`;
    },
    stopGrafeno() {
      return stopIncluded()
        ? "The included Grafeno was stopped. It starts again with the next session."
        : "The included Grafeno was not running from here.";
    },
    saveChoice(
      choice: ModelChoice & {
        provider?: string;
        autoProviders?: readonly string[];
        permissions?: PermissionMode;
      },
    ) {
      if (choice.permissions !== undefined) {
        save({ [PERMISSIONS_SETTING]: choice.permissions === "ask" ? "" : choice.permissions });
        return;
      }
      if (choice.autoProviders !== undefined) {
        save({ AGENT_AUTO_PROVIDERS: choice.autoProviders.join(",") });
        pooled = undefined;
        return;
      }
      if (choice.provider !== undefined) {
        // The chosen provider first; the model and effort are its own again.
        if (choice.provider === "auto") {
          save({ AGENT_PROVIDERS: "auto" });
          return;
        }
        // A run may move tasks to another provider: only to those Auto includes.
        const rest = autoMembers(env).filter((id) => id !== choice.provider);
        save({
          AGENT_PROVIDERS: [choice.provider, ...rest].join(","),
          CLAUDE_MODEL: "",
          AGENT_EFFORT: "",
        });
        return;
      }
      save({
        ...(choice.model === undefined
          ? {}
          : { CLAUDE_MODEL: choice.model === "default" ? "" : choice.model }),
        ...(choice.effort === undefined
          ? {}
          : { AGENT_EFFORT: choice.effort === "default" ? "" : choice.effort }),
      });
    },
    async orchestrator(extra, auto) {
      // Loaded when used: the orchestrator is not needed to chat.
      const { createOrchestrator } = await import("./orchestrate.js");
      return createOrchestrator(auto === true ? { auto: true, providers: inAuto() } : {}, extra);
    },
    pool: () => readyPool(inAuto()),
    async triage(message, signal) {
      const chosen = mostRoom(await readyPool(inAuto()));
      if (!chosen) return { route: "direct", reason: "no provider has room to triage" };
      const model = lightModel(chosen.provider);
      return triage(
        message,
        chosen.provider.create({ ...(model ? { model } : {}), effort: "low" }),
        `${chosen.provider.id}/${model ?? "default"}`,
        signal,
      );
    },
    async upkeep(session: AgentSession) {
      const report = await upkeep({
        vault: session.vault,
        palace: session.memory.palace,
        projectId: session.memory.projectId,
      });
      await session.memory.markUpkeep();
      return describeUpkeep(report);
    },
  };
}
