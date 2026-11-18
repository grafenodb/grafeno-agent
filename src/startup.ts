import { Grafeno, GrafenoError } from "@grafenodb/client";
import type { Config } from "./config.js";

/** What the start-up check found. */
export interface StartupReport {
  /** The Grafeno server's version. */
  readonly serverVersion: string;
  readonly namespace: string;
  /** The memory tools the agent's key may run in its namespace. */
  readonly tools: readonly string[];
  /** Who the agent is: its key's name, which Grafeno records on all it writes. */
  readonly identity?: AgentIdentity;
}

/** An agent's identity in Grafeno: the name of its key. */
export interface AgentIdentity {
  /** The key's name: recorded on everything the agent writes. */
  readonly name: string;
  /** The key may change only what it recorded itself (`--own-only`). */
  readonly ownOnly: boolean;
}

export type StartupFailure =
  | "unreachable" // nothing answers at the URL
  | "unhealthy" // the server answers but says it is not well
  | "unauthorized" // the key is wrong, revoked or expired
  | "forbidden" // the key works but may not use the namespace
  | "unexpected";

export class StartupError extends Error {
  constructor(
    readonly failure: StartupFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StartupError";
  }
}

export interface StartupOptions {
  /** A custom `fetch`, for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Checks that Grafeno answers (`/health`) and that the agent's key works in
 * its namespace (`GET /v1/{ns}/tools`). Throws a `StartupError` saying what
 * failed and what to do.
 */
export async function checkGrafeno(
  config: Config,
  options: StartupOptions = {},
): Promise<StartupReport> {
  const client = new Grafeno({
    url: config.grafenoUrl,
    token: config.agentKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  let health: { status: string; version: string };
  try {
    health = await client.health();
  } catch (error) {
    if (error instanceof GrafenoError && error.status !== 0) {
      throw new StartupError(
        "unhealthy",
        `Grafeno at ${config.grafenoUrl} answered /health with ${String(error.status)} ${error.code}: ${error.message}`,
        { cause: error },
      );
    }
    throw new StartupError(
      "unreachable",
      `Grafeno does not answer at ${config.grafenoUrl}. Is the server (or the Windows service "grafeno") running?`,
      { cause: error },
    );
  }
  if (health.status !== "ok") {
    throw new StartupError(
      "unhealthy",
      `Grafeno at ${config.grafenoUrl} reports status "${health.status}"`,
    );
  }

  let tools: { name: string }[];
  try {
    tools = await toolsOf(client, config);
  } catch (error) {
    if (error instanceof GrafenoError && error.status === 401) {
      throw new StartupError(
        "unauthorized",
        `Grafeno refused the agent's key (${error.code}). Check GRAFENO_AGENT_KEY, or ask an administrator for a new key.`,
        { cause: error },
      );
    }
    if (error instanceof GrafenoError && error.status === 403) {
      throw new StartupError(
        "forbidden",
        config.projectEntry && config.sharedNamespace
          ? `The agent's key may not make or use the project's namespace "${config.namespace}" (${error.code}). Each project has its own namespace: give the key admin on "${config.sharedNamespace}*" (grafeno keys create grafeno-agent --grant "${config.sharedNamespace}*:admin").`
          : `The agent's key may not use namespace "${config.namespace}" (${error.code}). Grant it, or set GRAFENO_NAMESPACE.`,
        { cause: error },
      );
    }
    throw new StartupError(
      "unexpected",
      `Listing the memory tools failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const identity = await whoAmI(client);
  return {
    serverVersion: health.version,
    namespace: config.namespace,
    tools: tools.map((tool) => tool.name),
    ...(identity === undefined ? {} : { identity }),
  };
}

/**
 * The memory tools of the agent's namespace; a namespace that does not exist
 * yet (a new project, or one deleted from the Memory window) is made first.
 */
async function toolsOf(client: Grafeno, config: Config): Promise<{ name: string }[]> {
  try {
    return await client.namespace(config.namespace).tools();
  } catch (error) {
    if (!(error instanceof GrafenoError && error.status === 404)) throw error;
    // Made the first time (or again, once deleted from the Memory window).
    await client.createNamespace(
      config.namespace,
      config.projectEntry
        ? `Grafeno Agent's memory of the project ${config.projectEntry.name} (${config.projectEntry.path})`
        : "Grafeno Agent's general memory (sessions outside a project)",
    );
    return client.namespace(config.namespace).tools();
  }
}

/**
 * The name of the agent's key (`GET /v1/whoami`), or nothing when the server
 * does not say: a server without keys, or one that is too old.
 */
async function whoAmI(client: Grafeno): Promise<AgentIdentity | undefined> {
  let me: Awaited<ReturnType<Grafeno["whoami"]>>;
  try {
    me = await client.whoami();
  } catch {
    return undefined;
  }
  const name = me.via?.kind === "key" ? me.via.name : me.name;
  if (typeof name !== "string" || name === "" || name === "anonymous") return undefined;
  return { name, ownOnly: me.own_only };
}
