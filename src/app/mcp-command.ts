import { connectMcp, type McpConnection } from "../mcp/client.js";
import { DEFAULTS, INCLUDED_GRAFENO_URL } from "../config.js";
import {
  GRAFENO_MCP,
  loadMcpConfig,
  looksLikeSecret,
  mcpConfigPath,
  mcpNameProblem,
  removeMcpServer,
  saveMcpServer,
  type McpServerConfig,
} from "../mcp/config.js";

export interface McpCommandOptions {
  readonly say: (line: string) => void;
  /** The file of servers; default: mcp.json next to the settings. */
  readonly path?: string;
  /** Connects to a server; default: for real. */
  readonly connect?: (name: string, config: McpServerConfig) => Promise<McpConnection>;
  /** The settings, for where Grafeno's own server is; default: the environment. */
  readonly env?: Record<string, string | undefined>;
}

/** Where Grafeno's own MCP server is, by the settings. */
function grafenoWhere(env: Record<string, string | undefined>): string {
  const url =
    env.GRAFENO_MODE?.trim() === "included"
      ? INCLUDED_GRAFENO_URL
      : env.GRAFENO_URL?.trim() || DEFAULTS.grafenoUrl;
  return `${url}, namespace ${env.GRAFENO_NAMESPACE?.trim() || DEFAULTS.namespace}`;
}

const USAGE = `grafeno-agent mcp                                   the servers, each checked: its tools, or why not
grafeno-agent mcp add <name> -- <command> [args…]   a program on this computer (stdio)
                 [--env NAME=value]…                 (value may be \${VAR}: kept in the environment)
grafeno-agent mcp add <name> --url <url>            a server at a URL (Streamable HTTP)
                 [--header Name=value]…              (value may be \${VAR}: kept in the environment)
grafeno-agent mcp remove <name>
Adding connects to the server first: it is kept only when it answers (--force keeps it anyway).`;

/**
 * `grafeno-agent mcp …`: the external MCP servers the agent connects to,
 * in mcp.json. A server is checked when it is added, and every time they
 * are listed.
 */
export async function mcpCommand(
  args: readonly string[],
  options: McpCommandOptions,
): Promise<number> {
  const { say } = options;
  const path = options.path ?? mcpConfigPath();
  const connect = options.connect ?? ((name, config) => connectMcp(name, config));
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls": {
      const config = loadMcpConfig(path);
      say(
        `  ${GRAFENO_MCP.padEnd(20)} built in · always on · the agent's memory (${grafenoWhere(options.env ?? process.env)})`,
      );
      say(`  ${" ".repeat(20)}   it cannot be turned off or removed: the agent works through it`);
      for (const problem of config.problems) say(`Problem: ${problem}`);
      const names = Object.keys(config.servers);
      if (names.length === 0) {
        say(`No external MCP servers yet (${path}).`);
        say(USAGE);
        return config.problems.length > 0 ? 1 : 0;
      }
      let failed = config.problems.length > 0;
      for (const name of names) {
        const server = config.servers[name] as McpServerConfig;
        const where = server.url ?? [server.command, ...(server.args ?? [])].join(" ");
        if (server.disabled) {
          say(`  ${name.padEnd(20)} disabled · ${where}`);
          continue;
        }
        const connection = await connect(name, server);
        await connection.close();
        if (connection.error) {
          failed = true;
          say(`  ${name.padEnd(20)} ✗ ${connection.error} · ${where}`);
        } else {
          say(`  ${name.padEnd(20)} ✓ ${String(connection.tools.length)} tools · ${where}`);
          say(`  ${" ".repeat(20)}   ${connection.tools.map((t) => t.name).join(", ")}`);
        }
        if (connection.missing.length > 0) {
          say(`  ${" ".repeat(20)}   not set: ${[...new Set(connection.missing)].join(", ")}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "add": {
      const name = args[1] ?? "";
      const why = mcpNameProblem(name);
      if (why) {
        say(`${why}.`);
        say(USAGE);
        return 2;
      }
      const server = parseServer(args.slice(2));
      if (typeof server === "string") {
        say(server);
        say(USAGE);
        return 2;
      }
      const inline = Object.entries({ ...server.env, ...server.headers }).filter(([, v]) =>
        looksLikeSecret(v),
      );
      if (inline.length > 0) {
        say(
          `${inline.map(([k]) => k).join(", ")} looks like a secret written in full: it would be kept in ${path}. Put it in an environment variable and write \${NAME} instead.`,
        );
        if (!args.includes("--force")) return 2;
      }
      say(`Connecting to ${name}…`);
      const connection = await connect(name, server);
      await connection.close();
      if (connection.error && !args.includes("--force")) {
        say(`${name} did not answer: ${connection.error}. Not kept (--force keeps it anyway).`);
        return 1;
      }
      saveMcpServer(name, server, path);
      say(
        connection.error
          ? `Kept ${name}, though it did not answer (${connection.error}).`
          : `${name} answered with ${String(connection.tools.length)} tools: ${connection.tools.map((t) => t.name).join(", ")}.`,
      );
      say(
        "Its tools reach the agent from its next session; those that change things ask you first.",
      );
      return 0;
    }
    case "remove":
    case "rm": {
      const name = args[1] ?? "";
      if (name.toLowerCase() === GRAFENO_MCP) {
        say(
          "grafeno is the agent's own MCP server (its memory): it cannot be removed or turned off.",
        );
        return 2;
      }
      if (!removeMcpServer(name, path)) {
        say(`No MCP server is named ${name}.`);
        return 1;
      }
      say(`Removed ${name}.`);
      return 0;
    }
    default:
      say(USAGE);
      return sub === "help" || sub === "--help" ? 0 : 2;
  }
}

/** The server an `add` describes: a command after `--`, or `--url`, with their values. */
export function parseServer(args: readonly string[]): McpServerConfig | string {
  const dash = args.indexOf("--");
  const options = dash >= 0 ? args.slice(0, dash) : args;
  const command = dash >= 0 ? args.slice(dash + 1) : [];
  const values = (flag: string) => {
    const out: string[] = [];
    for (let i = 0; i < options.length; i++) {
      if (options[i] === flag && options[i + 1] !== undefined) out.push(options[++i] ?? "");
    }
    return out;
  };
  const pairs = (flag: string): Record<string, string> | string => {
    const out: Record<string, string> = {};
    for (const pair of values(flag)) {
      const at = pair.indexOf("=");
      if (at <= 0) return `${flag} takes NAME=value: ${pair}`;
      out[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return out;
  };
  const url = values("--url")[0];
  if (url && command.length > 0) return "Either a command (after --) or --url, not both.";
  if (url) {
    const headers = pairs("--header");
    if (typeof headers === "string") return headers;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        return "The url is http or https.";
    } catch {
      return `Not a URL: ${url}`;
    }
    return { url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  const [program, ...rest] = command;
  if (!program) return "Say the server: a command after --, or --url.";
  const env = pairs("--env");
  if (typeof env === "string") return env;
  return {
    command: program,
    ...(rest.length > 0 ? { args: rest } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
