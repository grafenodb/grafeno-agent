import { Grafeno, GrafenoError } from "@grafenodb/client";
import type { Config } from "./config.js";

/** What the start-up check found. */
export interface StartupReport {
  /** The Grafeno server's version. */
  readonly serverVersion: string;
  readonly namespace: string;
  /** The memory tools the agent's key may run in its namespace. */
  readonly tools: readonly string[];
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
    tools = await client.namespace(config.namespace).tools();
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
        `The agent's key may not use namespace "${config.namespace}" (${error.code}). Grant it, or set GRAFENO_NAMESPACE.`,
        { cause: error },
      );
    }
    throw new StartupError(
      "unexpected",
      `Listing the memory tools failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return {
    serverVersion: health.version,
    namespace: config.namespace,
    tools: tools.map((tool) => tool.name),
  };
}
