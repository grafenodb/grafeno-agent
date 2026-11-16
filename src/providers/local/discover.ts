import type { LocalConnection } from "./store.js";

/**
 * A model a server offers, with what is known of it. A capability left
 * undefined is not known: the agent never assumes a local model takes
 * tools, structured output or a long context.
 */
export interface LocalModel {
  readonly id: string;
  readonly name: string;
  /** Loaded in memory now (answers without loading first). */
  readonly loaded?: boolean;
  /** The context it runs with (loaded), else the most it takes, in tokens. */
  readonly contextLength?: number;
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly thinking?: boolean;
  /** Its answers can be held to a JSON schema (the server enforces it). */
  readonly structured?: boolean;
  /** Size on disk, in bytes, when the server says. */
  readonly size?: number;
  /** Such as "8B" or "Q4_K_M", when the server says. */
  readonly detail?: string;
}

/** What a server answered: whether it is there, its version, its models. */
export interface Discovery {
  readonly reachable: boolean;
  readonly version?: string;
  readonly models: readonly LocalModel[];
  /** It asked for a key, or refused the one given. */
  readonly needsKey?: boolean;
  /** Why it could not be read, in a few words. */
  readonly error?: string;
  /** How long its first answer took, in ms. */
  readonly latencyMs?: number;
}

export interface DiscoverOptions {
  readonly key?: string;
  readonly fetch?: typeof fetch;
  /** For each request. Default: 4 s (a server on this computer answers at once). */
  readonly timeoutMs?: number;
  /** Most models asked about one by one (Ollama's /api/show). Default: 40. */
  readonly detailLimit?: number;
}

class Refused extends Error {}

/** The server's root: an OpenAI-compatible address without its `/v1`. */
export function rootOf(url: string): string {
  return url.replace(/\/v1$/, "");
}

/** Its OpenAI-compatible base: with `/v1` (LM Studio, Ollama's compatibility API). */
export function openAiBase(connection: Pick<LocalConnection, "kind" | "url">): string {
  return connection.kind === "ollama" ? `${rootOf(connection.url)}/v1` : connection.url;
}

/** Reads what a server offers, spending nothing: no model is run, none is loaded. */
export async function discover(
  connection: LocalConnection,
  options: DiscoverOptions = {},
): Promise<Discovery> {
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 4000;
  const headers: Record<string, string> = options.key
    ? { authorization: `Bearer ${options.key}` }
    : {};
  const started = Date.now();
  let latency: number | undefined;
  const get = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await doFetch(url, {
      ...init,
      redirect: "error",
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeout),
    });
    latency ??= Date.now() - started;
    if (response.status === 401 || response.status === 403) throw new Refused();
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return response.json();
  };
  try {
    const found =
      connection.kind === "ollama"
        ? await discoverOllama(connection, get, options.detailLimit ?? 40)
        : connection.kind === "lmstudio"
          ? await discoverLmStudio(connection, get)
          : await discoverOpenAi(connection, get);
    return { reachable: true, ...found, ...(latency === undefined ? {} : { latencyMs: latency }) };
  } catch (error) {
    if (error instanceof Refused) {
      return {
        reachable: true,
        models: [],
        needsKey: true,
        error: options.key ? "the server refused the key" : "the server asks for a key",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      models: [],
      error: /timeout|abort/i.test(message)
        ? "no answer in time"
        : /HTTP \d+/.test(message)
          ? `the server answered ${message}`
          : "nothing answers at that address",
    };
  }
}

type Get = (url: string, init?: RequestInit) => Promise<unknown>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Ollama: its version, installed models, each one's capabilities and context; which are loaded. */
async function discoverOllama(
  connection: LocalConnection,
  get: Get,
  detailLimit: number,
): Promise<Omit<Discovery, "reachable">> {
  const root = rootOf(connection.url);
  const version = str(((await get(`${root}/api/version`)) as { version?: unknown }).version);
  const tags = (await get(`${root}/api/tags`)) as {
    models?: {
      name?: string;
      model?: string;
      size?: number;
      details?: { parameter_size?: string; quantization_level?: string };
    }[];
  };
  const running = await get(`${root}/api/ps`)
    .then((r) => (r as { models?: { name?: string; model?: string }[] }).models ?? [])
    .catch(() => []);
  const loaded = new Set(running.flatMap((m) => [m.name, m.model].filter(Boolean)));
  const listed = (tags.models ?? []).filter((m) => typeof (m.model ?? m.name) === "string");
  const models = await Promise.all(
    listed.map(async (m, index): Promise<LocalModel | undefined> => {
      const id = (m.model ?? m.name) as string;
      const detail = [m.details?.parameter_size, m.details?.quantization_level]
        .filter(Boolean)
        .join(" ");
      const base: LocalModel = {
        id,
        name: m.name ?? id,
        loaded: loaded.has(id) || loaded.has(m.name),
        // The server holds every answer to a JSON schema when asked (its `format`).
        structured: true,
        ...(num(m.size) === undefined ? {} : { size: m.size }),
        ...(detail ? { detail } : {}),
      };
      if (index >= detailLimit) return base;
      const shown = (await get(`${root}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
      }).catch(() => undefined)) as
        { capabilities?: unknown; model_info?: Record<string, unknown> } | undefined;
      if (!shown) return base;
      const capabilities = Array.isArray(shown.capabilities)
        ? shown.capabilities.filter((c): c is string => typeof c === "string")
        : undefined;
      // An embedding model answers no chat: not offered.
      if (capabilities && !capabilities.includes("completion")) return undefined;
      const context = Object.entries(shown.model_info ?? {}).find(([k]) =>
        k.endsWith(".context_length"),
      )?.[1];
      return {
        ...base,
        ...(capabilities
          ? {
              tools: capabilities.includes("tools"),
              vision: capabilities.includes("vision"),
              thinking: capabilities.includes("thinking"),
            }
          : {}),
        ...(num(context) === undefined ? {} : { contextLength: context as number }),
      };
    }),
  );
  return {
    ...(version ? { version } : {}),
    models: models.filter((m): m is LocalModel => m !== undefined),
  };
}

/**
 * LM Studio: its REST API's models (v1: capabilities, loaded instances and
 * their context; else v0: state and maximum context), else its
 * OpenAI-compatible list (names only).
 */
async function discoverLmStudio(
  connection: LocalConnection,
  get: Get,
): Promise<Omit<Discovery, "reachable">> {
  const root = rootOf(connection.url);
  try {
    const v1 = (await get(`${root}/api/v1/models`)) as {
      models?: {
        type?: string;
        key?: string;
        display_name?: string;
        params_string?: string;
        quantization?: { name?: string } | string;
        loaded_instances?: { config?: { context_length?: number } }[];
        max_context_length?: number | null;
        capabilities?: { vision?: boolean; trained_for_tool_use?: boolean; reasoning?: unknown };
      }[];
    };
    if (Array.isArray(v1.models)) {
      return {
        models: v1.models
          .filter((m) => m.type === "llm" && typeof m.key === "string")
          .map((m) => {
            const instance = m.loaded_instances?.[0];
            const context = num(instance?.config?.context_length) ?? num(m.max_context_length);
            const quantization =
              typeof m.quantization === "string" ? m.quantization : m.quantization?.name;
            const detail = [m.params_string, quantization].filter(Boolean).join(" ");
            return {
              id: m.key as string,
              name: m.display_name ?? (m.key as string),
              loaded: (m.loaded_instances?.length ?? 0) > 0,
              // Its OpenAI-compatible API holds answers to a JSON schema (structured output).
              structured: true,
              ...(m.capabilities
                ? {
                    tools: m.capabilities.trained_for_tool_use === true,
                    vision: m.capabilities.vision === true,
                    thinking: m.capabilities.reasoning !== undefined,
                  }
                : {}),
              ...(context === undefined ? {} : { contextLength: context }),
              ...(detail ? { detail } : {}),
            };
          }),
      };
    }
  } catch (error) {
    if (error instanceof Refused) throw error;
    // An older LM Studio: its v0 REST API, then the OpenAI-compatible list.
  }
  try {
    const v0 = (await get(`${root}/api/v0/models`)) as {
      data?: {
        id?: string;
        type?: string;
        state?: string;
        max_context_length?: number;
        quantization?: string;
      }[];
    };
    if (Array.isArray(v0.data)) {
      return {
        models: v0.data
          .filter((m) => (m.type === "llm" || m.type === "vlm") && typeof m.id === "string")
          .map((m) => ({
            id: m.id as string,
            name: m.id as string,
            loaded: m.state === "loaded",
            structured: true,
            ...(m.type === "vlm" ? { vision: true } : {}),
            ...(num(m.max_context_length) === undefined
              ? {}
              : { contextLength: m.max_context_length as number }),
            ...(m.quantization ? { detail: m.quantization } : {}),
          })),
      };
    }
  } catch (error) {
    if (error instanceof Refused) throw error;
  }
  return discoverOpenAi(connection, get);
}

/** An OpenAI-compatible server (Bionic, any other): its model list, names only. */
async function discoverOpenAi(
  connection: LocalConnection,
  get: Get,
): Promise<Omit<Discovery, "reachable">> {
  const listed = (await get(`${openAiBase(connection)}/models`)) as {
    data?: { id?: string; name?: string }[];
  };
  return {
    models: (listed.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id as string, name: m.name ?? (m.id as string) })),
  };
}

/** A model's known capabilities, in a few words: "tools · 32k context · loaded". */
export function describeModel(model: LocalModel): string {
  const parts: string[] = [];
  if (model.tools === true) parts.push("tools");
  else if (model.tools === false) parts.push("no tools");
  else parts.push("tools unknown");
  if (model.vision === true) parts.push("vision");
  if (model.contextLength !== undefined) {
    parts.push(`${String(Math.round(model.contextLength / 1024))}k context`);
  }
  if (model.loaded === true) parts.push("loaded");
  if (model.detail) parts.push(model.detail);
  return parts.join(" · ");
}
