import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "../agent/tools.js";
import { expand, expandAll, type McpServerConfig } from "./config.js";

/** One server, connected or not, and the tools it gives the agent. */
export interface McpConnection {
  readonly name: string;
  readonly tools: readonly Tool[];
  /** Why it is not connected. */
  readonly error?: string;
  /** Environment variables its configuration names but are not set. */
  readonly missing: readonly string[];
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Where `${NAME}` values are read. Default: the process's environment. */
  readonly env?: Record<string, string | undefined>;
  /** Time to connect and list tools. Default: 15 seconds. */
  readonly timeoutMs?: number;
  /** Time one tool call may take. Default: 2 minutes. */
  readonly callTimeoutMs?: number;
  readonly version?: string;
}

/** Characters of a tool's answer given to the model at most. */
const MAX_ANSWER = 100_000;

/** The agent's name for a server's tool: `mcp_<server>_<tool>`, at most 64 characters. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Connects to one external MCP server and turns its tools into the
 * agent's: each named `mcp_<server>_<tool>`, and asked of the person before
 * it runs unless the server marks it read-only. A program run over stdio
 * gets only a minimal environment (the SDK's default) plus what its
 * configuration sets, never the agent's keys. A server that cannot be
 * reached is reported, not fatal.
 */
export async function connectMcp(
  name: string,
  config: McpServerConfig,
  options: ConnectOptions = {},
): Promise<McpConnection> {
  const env = options.env ?? process.env;
  const missing: string[] = [];
  let transport: Transport;
  if (config.url) {
    const url = expand(config.url, env);
    const headers = expandAll(config.headers, env);
    missing.push(...url.missing, ...headers.missing);
    transport = new StreamableHTTPClientTransport(new URL(url.value), {
      requestInit: { headers: headers.values },
    });
  } else {
    const vars = expandAll(config.env, env);
    const args = (config.args ?? []).map((a) => expand(a, env));
    missing.push(...vars.missing, ...args.flatMap((a) => a.missing));
    transport = new StdioClientTransport({
      command: config.command ?? "",
      args: args.map((a) => a.value),
      env: { ...getDefaultEnvironment(), ...vars.values },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      // Its own messages would cover the interface.
      stderr: "ignore",
    });
  }
  const client = new Client({ name: "grafeno-agent", version: options.version ?? "0" });
  const close = async () => {
    await client.close().catch(() => undefined);
  };
  try {
    const listed = await withTimeout(
      (async () => {
        await client.connect(transport);
        const all: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          all.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return all;
      })(),
      options.timeoutMs ?? 15_000,
      `${name} did not answer in time`,
    );
    const tools = listed.map((tool): Tool => {
      const readOnly = tool.annotations?.readOnlyHint === true;
      const destructive = tool.annotations?.destructiveHint === true;
      return {
        name: mcpToolName(name, tool.name),
        description: `[MCP server ${name}] ${tool.description ?? tool.title ?? tool.name}`,
        inputSchema: tool.inputSchema,
        writes: !readOnly,
        permission: () =>
          readOnly
            ? { permission: "free", reason: `${name} marks it read-only` }
            : {
                permission: "ask",
                reason: destructive
                  ? `a tool of the MCP server ${name} that may delete or overwrite`
                  : `a tool of the MCP server ${name}`,
              },
        describe: (input) => `${name} · ${tool.name} ${JSON.stringify(input).slice(0, 300)}`,
        async run(input, context) {
          const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
            signal: context.signal,
            timeout: options.callTimeoutMs ?? 120_000,
          });
          const text = answerText(result.content);
          if (result.isError === true) throw new Error(text || "the tool failed");
          return text.length <= MAX_ANSWER
            ? text
            : `${text.slice(0, MAX_ANSWER)}\n… (${String(text.length - MAX_ANSWER)} characters left out)`;
        },
      };
    });
    return { name, tools, missing, close };
  } catch (error) {
    await close();
    return {
      name,
      tools: [],
      missing,
      error: error instanceof Error ? error.message : String(error),
      close: () => Promise.resolve(),
    };
  }
}

/** Every server of the configuration that is not disabled, connected at once. */
export async function connectAll(
  servers: Readonly<Record<string, McpServerConfig>>,
  options: ConnectOptions = {},
): Promise<McpConnection[]> {
  return Promise.all(
    Object.entries(servers)
      .filter(([, config]) => config.disabled !== true)
      .map(([name, config]) => connectMcp(name, config, options)),
  );
}

/** What a tool answered, as text: its text parts, and a word for each other part. */
function answerText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string; resource?: { uri?: string; text?: string } }) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "resource")
        return part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`;
      return `[${part.type ?? "content"}]`;
    })
    .join("\n");
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
