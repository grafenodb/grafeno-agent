import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingsPath } from "../../settings-file.js";
import { checkEndpoint } from "./endpoint.js";

/** The kinds of model server the agent connects to. */
export const LOCAL_KINDS = ["ollama", "lmstudio", "bionic", "openai-compatible"] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];

/** Each kind as a person reads it, its documented default address, and whether it needs a key. */
export const LOCAL_KIND_INFO: Readonly<
  Record<
    LocalKind,
    {
      readonly name: string;
      /** The address its documentation gives; none for a server only its owner knows. */
      readonly defaultUrl?: string;
      readonly key: "none" | "optional" | "required";
      readonly docs: string;
    }
  >
> = {
  ollama: {
    name: "Ollama",
    defaultUrl: "http://localhost:11434",
    key: "optional",
    docs: "https://docs.ollama.com/api",
  },
  lmstudio: {
    name: "LM Studio",
    defaultUrl: "http://localhost:1234/v1",
    key: "optional",
    docs: "https://lmstudio.ai/docs/developer",
  },
  bionic: {
    name: "Bionic",
    // Its documentation's example is http://localhost/v1, "replaced with your production domain".
    key: "required",
    docs: "https://bionic-gpt.com/docs/guides/api/",
  },
  "openai-compatible": {
    name: "OpenAI-compatible endpoint",
    key: "optional",
    docs: "https://platform.openai.com/docs/api-reference/chat",
  },
};

/** How a connection's model answers: settings sent with each request. */
export interface InferenceSettings {
  readonly temperature?: number;
  /** The context the model is run with, in tokens (Ollama's num_ctx). */
  readonly contextLength?: number;
  /** The most tokens one answer may take. */
  readonly maxTokens?: number;
  /** How long Ollama keeps the model loaded after a request ("5m", "0"). */
  readonly keepAlive?: string;
}

/** A model server the person connected: kind, address, the model it uses by default. */
export interface LocalConnection {
  /** Its id: what settings and commands name (`ollama`, `lmstudio`, `bionic`, `gpu-box`…). */
  readonly id: string;
  readonly kind: LocalKind;
  /** Its name in lists: "Ollama", "LM Studio (gpu-box)". */
  readonly name: string;
  readonly url: string;
  readonly defaultModel?: string;
  /** Its key is in the system's secure store (never in this file). */
  readonly hasKey?: boolean;
  /** The longest a request may take, in ms. Default: ten minutes (a local model can be slow). */
  readonly timeoutMs?: number;
  readonly inference?: InferenceSettings;
}

/** The longest a request to a local model may take by default. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the connections are kept: next to the settings, no secrets in it. */
export function localConnectionsFile(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dirname(settingsPath(env)), "local-connections.json");
}

/** The two servers every install knows, at their documented addresses, until the person changes them. */
export function builtInConnections(): LocalConnection[] {
  return [
    {
      id: "ollama",
      kind: "ollama",
      name: "Ollama",
      url: LOCAL_KIND_INFO.ollama.defaultUrl ?? "",
    },
    {
      id: "lmstudio",
      kind: "lmstudio",
      name: "LM Studio",
      url: LOCAL_KIND_INFO.lmstudio.defaultUrl ?? "",
    },
  ];
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Why an id cannot name a connection, or undefined. */
export function connectionIdProblem(id: string): string | undefined {
  return ID.test(id)
    ? undefined
    : "a connection's id has 1 to 40 lowercase letters, digits or dashes";
}

function valid(entry: unknown): entry is LocalConnection {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    ID.test(e.id) &&
    typeof e.kind === "string" &&
    (LOCAL_KINDS as readonly string[]).includes(e.kind) &&
    typeof e.url === "string" &&
    checkEndpoint(e.url).ok
  );
}

/** The connections: the built-in ones (as the person changed them), then the ones they added. */
export function loadLocalConnections(file = localConnectionsFile()): LocalConnection[] {
  let saved: LocalConnection[] = [];
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { connections?: unknown };
      saved = Array.isArray(data.connections) ? data.connections.filter(valid) : [];
    } catch {
      saved = [];
    }
  }
  const builtIn = builtInConnections().map((b) => saved.find((s) => s.id === b.id) ?? b);
  const added = saved.filter((s) => !builtIn.some((b) => b.id === s.id));
  return [...builtIn, ...added].map((c) => ({
    ...c,
    name: typeof c.name === "string" && c.name !== "" ? c.name : LOCAL_KIND_INFO[c.kind].name,
  }));
}

function save(connections: readonly LocalConnection[], file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ connections }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** Adds a connection, or replaces the one with its id. The address is checked first. */
export function saveLocalConnection(
  connection: LocalConnection,
  file = localConnectionsFile(),
): LocalConnection {
  const why = connectionIdProblem(connection.id);
  if (why) throw new Error(why);
  const checked = checkEndpoint(connection.url, { withKey: connection.hasKey === true });
  if (!checked.ok) throw new Error(`${connection.url}: ${checked.reason}`);
  const entry = { ...connection, url: checked.url };
  const saved = existsSync(file)
    ? loadLocalConnections(file).filter((c) => c.id !== entry.id)
    : builtInConnections().filter((c) => c.id !== entry.id);
  save([...saved, entry], file);
  return entry;
}

/**
 * Removes a connection. A built-in one (ollama, lmstudio) goes back to its
 * documented address instead; false when there was none of that id.
 */
export function removeLocalConnection(id: string, file = localConnectionsFile()): boolean {
  const all = loadLocalConnections(file);
  if (!all.some((c) => c.id === id)) return false;
  const builtIn = builtInConnections().find((b) => b.id === id);
  save(
    all.map((c) => (c.id === id ? builtIn : c)).filter((c): c is LocalConnection => !!c),
    file,
  );
  return true;
}

/** A free id for a new connection of a kind: the kind's own, then with a number. */
export function freeConnectionId(
  kind: LocalKind,
  taken: readonly string[],
  base: string = kind === "openai-compatible" ? "custom" : kind,
): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n)}`;
    if (!taken.includes(id)) return id;
  }
}
