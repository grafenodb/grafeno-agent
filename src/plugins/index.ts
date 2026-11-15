import type { Tool } from "../agent/tools.js";
import { githubPlugin } from "./github.js";
import { gitlabPlugin } from "./gitlab.js";
import type { Plugin, PluginStatus } from "./types.js";

export type { Plugin, PluginStatus } from "./types.js";

/** Every plugin the agent knows. */
export const KNOWN_PLUGINS: Readonly<
  Record<string, (env: Record<string, string | undefined>) => Plugin>
> = {
  github: (env) => githubPlugin({ env }),
  gitlab: (env) => gitlabPlugin({ env }),
};

/** The setting that lists the plugins the agent uses. */
export const PLUGINS_SETTING = "AGENT_PLUGINS";

/** The plugins turned on (AGENT_PLUGINS), known ones only. None until the user turns one on. */
export function enabledPluginIds(env: Record<string, string | undefined> = process.env): string[] {
  return [
    ...new Set(
      (env[PLUGINS_SETTING] ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id in KNOWN_PLUGINS),
    ),
  ];
}

/** One plugin's state for a session. */
export interface PluginState {
  readonly id: string;
  readonly name: string;
  readonly status: PluginStatus;
  readonly tools: number;
}

/**
 * The plugins turned on, connected: their tools for the agent, each one's
 * state, and what to tell the person (one not connected).
 */
export async function connectPlugins(
  env: Record<string, string | undefined>,
  root: string,
  make: (id: string) => Plugin = (id) => (KNOWN_PLUGINS[id] as (e: typeof env) => Plugin)(env),
): Promise<{ tools: Tool[]; states: PluginState[]; notes: string[] }> {
  const found = await Promise.all(
    enabledPluginIds(env).map(async (id) => {
      const plugin = make(id);
      const status = await plugin.status().catch((error: unknown): PluginStatus => ({
        ready: false,
        host: "",
        detail: error instanceof Error ? error.message : String(error),
      }));
      const tools = status.ready ? await plugin.tools({ root }).catch(() => []) : [];
      return { plugin, status, tools };
    }),
  );
  return {
    tools: found.flatMap((f) => f.tools),
    states: found.map((f) => ({
      id: f.plugin.id,
      name: f.plugin.name,
      status: f.status,
      tools: f.tools.length,
    })),
    notes: found
      .filter((f) => !f.status.ready)
      .map((f) => `Plugin ${f.plugin.name} is on but not connected: ${f.status.detail}`),
  };
}
