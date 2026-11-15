import type { Tool } from "../agent/tools.js";

/** How a plugin reaches its service. */
export type PluginVia = "cli" | "token";

/** Whether a plugin can be used now, and as whom. */
export interface PluginStatus {
  readonly ready: boolean;
  /** The official CLI's own sign-in, or a token the user made. */
  readonly via?: PluginVia;
  /** The account it answers as. */
  readonly account?: string;
  /** The service's host, such as github.com. */
  readonly host: string;
  /** In a few words: how it is connected, or what to do. */
  readonly detail: string;
}

/** One answer of a service's API. */
export interface ApiResponse {
  readonly status: number;
  /** The body as JSON, when it is JSON. */
  readonly data: unknown;
  readonly text: string;
}

/** How a plugin talks to its service's REST API. */
export interface ApiTransport {
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ApiResponse>;
}

/** What a plugin's tools need: the project's folder (its git remote says the repository). */
export interface PluginContext {
  readonly root: string;
}

/**
 * A plugin: a service outside this computer (GitHub, GitLab…) the agent can
 * work with through the service's own public API, as the user, with a
 * sign-in the service documents for it. Nothing else: no scraping, no
 * credentials taken from other programs.
 */
export interface Plugin {
  readonly id: string;
  readonly name: string;
  /** What it lets the agent do, in one line. */
  readonly description: string;
  /** The terms its use is under, and the sign-ins it accepts: shown to the user. */
  readonly terms: readonly string[];
  /** How to connect it. */
  readonly connect: string;
  status(): Promise<PluginStatus>;
  /** Its tools, over the transport the status found. */
  tools(context: PluginContext): Promise<Tool[]>;
}
