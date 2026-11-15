import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingsPath } from "../settings-file.js";

/**
 * An external MCP server, as the common `mcpServers` format writes it: a
 * program run on this computer (`command`, over stdio), or a server at a
 * URL (Streamable HTTP). Values may name environment variables as
 * `${NAME}`, so that tokens stay in the environment, not in this file.
 */
export interface McpServerConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Kept, but not connected. */
  readonly disabled?: boolean;
}

export interface McpConfig {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** What could not be read, said to the person. */
  readonly problems: readonly string[];
}

/** Where the agent's MCP servers are kept: mcp.json, next to its settings. */
export function mcpConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(settingsPath(env)), "mcp.json");
}

/**
 * The name of Grafeno's own MCP server: the agent's memory, built in and
 * always on. No external server may take it.
 */
export const GRAFENO_MCP = "grafeno";

/** Why a server's name cannot be used, or undefined. */
export function mcpNameProblem(name: string): string | undefined {
  if (name.toLowerCase() === GRAFENO_MCP) {
    return "grafeno is the agent's own MCP server (its memory), built in and always on: give yours another name";
  }
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)
    ? undefined
    : "a server's name has 1 to 32 letters, digits, - or _, starting with a letter or digit";
}

/** The servers in the file; none when there is no file. */
export function loadMcpConfig(path = mcpConfigPath()): McpConfig {
  if (!existsSync(path)) return { servers: {}, problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      servers: {},
      problems: [`${path} is not valid JSON: ${error instanceof Error ? error.message : ""}`],
    };
  }
  const raw = (data as { mcpServers?: unknown } | null)?.mcpServers;
  if (raw === undefined) return { servers: {}, problems: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { servers: {}, problems: [`${path}: mcpServers is not an object`] };
  }
  const servers: Record<string, McpServerConfig> = {};
  const problems: string[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const why = mcpNameProblem(name) ?? serverProblem(value);
    if (why) problems.push(`${name}: ${why}`);
    else servers[name] = value as McpServerConfig;
  }
  return { servers, problems };
}

function serverProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return "not an object";
  const v = value as Record<string, unknown>;
  const hasCommand = typeof v.command === "string" && v.command !== "";
  const hasUrl = typeof v.url === "string" && v.url !== "";
  if (hasCommand === hasUrl) return "it needs either a command or a url";
  if (
    v.args !== undefined &&
    !(Array.isArray(v.args) && v.args.every((a) => typeof a === "string"))
  ) {
    return "args is a list of strings";
  }
  for (const key of ["env", "headers"]) {
    const map = v[key];
    if (
      map !== undefined &&
      (map === null ||
        typeof map !== "object" ||
        !Object.values(map).every((x) => typeof x === "string"))
    ) {
      return `${key} maps names to strings`;
    }
  }
  if (hasUrl) {
    try {
      const url = new URL(v.url as string);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "the url is http or https";
    } catch {
      return "the url is not valid";
    }
  }
  return undefined;
}

/** Writes a server into the file (made when missing), keeping the others. */
export function saveMcpServer(name: string, server: McpServerConfig, path = mcpConfigPath()): void {
  writeServers(path, (servers) => ({ ...servers, [name]: server }));
}

/** Removes a server from the file; false when it was not there. */
export function removeMcpServer(name: string, path = mcpConfigPath()): boolean {
  let found = false;
  writeServers(path, (servers) => {
    found = name in servers;
    const rest = { ...servers };
    Reflect.deleteProperty(rest, name);
    return rest;
  });
  return found;
}

function writeServers(
  path: string,
  change: (servers: Record<string, unknown>) => Record<string, unknown>,
): void {
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }
  const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const next = { ...data, mcpServers: change(servers) };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * A value with its `${NAME}` taken from the environment, and the names that
 * were not set (they become empty).
 */
export function expand(
  value: string,
  env: Record<string, string | undefined>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
    const found = env[name];
    if (found === undefined) missing.push(name);
    return found ?? "";
  });
  return { value: out, missing };
}

/** Each value of a map expanded; with every name that was not set. */
export function expandAll(
  map: Readonly<Record<string, string>> | undefined,
  env: Record<string, string | undefined>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, raw] of Object.entries(map ?? {})) {
    const done = expand(raw, env);
    values[key] = done.value;
    missing.push(...done.missing);
  }
  return { values, missing };
}

/**
 * A value that looks like a secret written as it is (a long token), not as
 * `${NAME}`: said when a server is added, so that it can be moved to the
 * environment.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.includes("${")) return false;
  const token = value.replace(/^(Bearer|Basic|Token)\s+/i, "");
  return token.length >= 20 && /^[A-Za-z0-9._~+/=-]+$/.test(token) && /\d/.test(token);
}
