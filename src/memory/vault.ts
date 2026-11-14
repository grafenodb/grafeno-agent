import { Grafeno } from "@grafenodb/client";
import type { Config } from "../config.js";
import type { JsonSchema } from "../model/index.js";

/** What a memory tool answered. */
export interface VaultAnswer {
  /** The answer as text, as a model reads it. */
  readonly text: string;
  /** The tool refused or failed; `text` says why. */
  readonly isError: boolean;
  /** The answer as data, when the tool gives one. */
  readonly data?: unknown;
}

export interface VaultTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/**
 * The agent's memory in Grafeno: its namespace's memory tools, run with the
 * agent's own key. Everything the agent remembers goes through here.
 */
export interface Vault {
  readonly namespace: string;
  tools(): Promise<readonly VaultTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<VaultAnswer>;
}

/** The vault on the Grafeno server of the settings. */
export function grafenoVault(config: Config, options: { fetch?: typeof fetch } = {}): Vault {
  const client = new Grafeno({
    url: config.grafenoUrl,
    token: config.agentKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const namespace = client.namespace(config.namespace);
  return {
    namespace: config.namespace,
    tools: async () =>
      (await namespace.tools()).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    call: async (name, args) => {
      const result = await namespace.callTool(name, args);
      return {
        text: result.content.map((part) => part.text).join("\n"),
        isError: result.isError,
        ...(result.structuredContent === undefined ? {} : { data: result.structuredContent }),
      };
    },
  };
}

/** The `id` a tool answered with, when it did. */
export function answerId(answer: VaultAnswer): string | undefined {
  const fromData = idOf(answer.data);
  if (fromData !== undefined) return fromData;
  try {
    return idOf(JSON.parse(answer.text));
  } catch {
    return undefined;
  }
}

function idOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}
