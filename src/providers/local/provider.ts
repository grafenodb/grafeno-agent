import { dataDir } from "../../data-dir.js";
import { ModelError } from "../../model/errors.js";
import { resilient } from "../../model/index.js";
import { OllamaModel } from "../../model/ollama.js";
import { ChatCompletionsModel } from "../../model/openai-chat.js";
import type { Model } from "../../model/types.js";
import { ComposedProvider } from "../compose.js";
import { systemSecretStore, type SecretStore } from "../secrets.js";
import type {
  ModelCatalog,
  ModelChoice,
  ModelOption,
  ProviderAuth,
  ProviderRuntime,
  ProviderStatus,
  ProviderUsage,
} from "../types.js";
import {
  describeModel,
  discover,
  openAiBase,
  rootOf,
  type Discovery,
  type LocalModel,
} from "./discover.js";
import { checkEndpoint, localityText, resolveEndpoint, type Locality } from "./endpoint.js";
import { DEFAULT_TIMEOUT_MS, LOCAL_KIND_INFO, type LocalConnection } from "./store.js";

export interface LocalSettings {
  readonly store?: SecretStore;
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  /** How long what a server answered is reused, in ms. Default: 30 s. */
  readonly cacheMs?: number;
  /** Resolves a server's name (to see where it really leads); for tests. */
  readonly resolve?: (host: string) => Promise<string[]>;
}

/** The secure store's account for a connection's key. */
export function localKeyAccount(id: string): string {
  return `${id}-key`;
}

/** A context too short for the agent's instructions, tools and a file or two. */
export const MIN_AGENT_CONTEXT = 16_384;

/**
 * What a local connection knows: its server's answers (models, version),
 * read at most every half minute, and its key, when it has one.
 */
export class LocalState {
  #read: { at: number; found: Promise<Discovery> } | undefined;
  #locality: Promise<Locality | { refused: string }> | undefined;

  constructor(
    readonly connection: LocalConnection,
    private readonly settings: LocalSettings = {},
  ) {}

  store(): SecretStore {
    return this.settings.store ?? systemSecretStore(dataDir(this.settings.env ?? process.env));
  }

  key = async (): Promise<string | undefined> => {
    if (this.connection.hasKey !== true) return undefined;
    return this.store()
      .get(localKeyAccount(this.connection.id))
      .catch(() => undefined);
  };

  /** Where the server is, its name resolved; or why it is never reached. */
  locality(): Promise<Locality | { refused: string }> {
    this.#locality ??= (async () => {
      const checked = checkEndpoint(this.connection.url, {
        withKey: this.connection.hasKey === true,
      });
      if (!checked.ok) return { refused: checked.reason };
      const resolved = await resolveEndpoint(checked, this.settings.resolve);
      return resolved.ok ? resolved.locality : { refused: resolved.reason };
    })();
    return this.#locality;
  }

  /** What the server offers now (spending nothing); `fresh` asks again. */
  discovery(fresh = false): Promise<Discovery> {
    const ttl = this.settings.cacheMs ?? 30_000;
    if (!fresh && this.#read && Date.now() - this.#read.at < ttl) return this.#read.found;
    const found = (async (): Promise<Discovery> => {
      const where = await this.locality();
      if (typeof where === "object") {
        return { reachable: false, models: [], error: where.refused };
      }
      const key = await this.key();
      return discover(this.connection, {
        ...(key ? { key } : {}),
        ...(this.settings.fetch ? { fetch: this.settings.fetch } : {}),
      });
    })();
    this.#read = { at: Date.now(), found };
    return found;
  }

  /** The model used when none was chosen: the connection's default, else a loaded one that takes tools, else the first. */
  async defaultModel(): Promise<LocalModel> {
    const { models, reachable, error } = await this.discovery();
    if (!reachable) {
      throw new ModelError(
        "unavailable",
        `${this.connection.name} is not answering at ${this.connection.url}${error ? ` (${error})` : ""}.`,
      );
    }
    const chosen = this.connection.defaultModel;
    if (chosen) {
      return models.find((m) => m.id === chosen) ?? { id: chosen, name: chosen };
    }
    const best =
      models.find((m) => m.loaded === true && m.tools === true) ??
      models.find((m) => m.tools === true) ??
      models.find((m) => m.loaded === true) ??
      models[0];
    if (!best) {
      throw new ModelError(
        "setup",
        `${this.connection.name} has no model to use: ${
          this.connection.kind === "ollama"
            ? "pull one (ollama pull <model>)"
            : "download or load one on the server"
        }, then choose it in /connect.`,
      );
    }
    return best;
  }

  /** A model as the server described it; a name only, when it was not listed. */
  async model(id: string): Promise<LocalModel> {
    const { models } = await this.discovery();
    return models.find((m) => m.id === id) ?? { id, name: id };
  }
}

/** A local connection's status: whether its server answers, and where it is. */
export class LocalAuth implements ProviderAuth {
  readonly method = "local-server";

  constructor(private readonly state: LocalState) {}

  get signIn(): string {
    const { kind, url } = this.state.connection;
    const info = LOCAL_KIND_INFO[kind];
    return kind === "ollama"
      ? `Start Ollama (ollama serve) at ${url}, then pull a model (ollama pull <model>).`
      : kind === "lmstudio"
        ? `Start LM Studio's server (lms server start, or the Developer tab) at ${url}, and load a model.`
        : `Check that ${info.name} answers at ${url}${info.key === "required" ? ", with your key" : ""}.`;
  }

  async status(): Promise<ProviderStatus> {
    const connection = this.state.connection;
    const where = await this.state.locality();
    if (typeof where === "object") {
      return { installed: false, signedIn: false, detail: `Not used: ${where.refused}.` };
    }
    const found = await this.state.discovery();
    const at = `${connection.url} (${localityText(where)})`;
    if (!found.reachable) {
      return {
        installed: false,
        signedIn: false,
        detail: `Not answering at ${at}${found.error ? `: ${found.error}` : ""}. ${this.signIn}`,
      };
    }
    if (found.needsKey) {
      return {
        installed: true,
        signedIn: false,
        detail: `${connection.name} at ${at} ${found.error ?? "asks for a key"}: set it in /connect.`,
      };
    }
    const tools = found.models.filter((m) => m.tools === true).length;
    const billing = {
      kind: "local" as const,
      detail:
        where === "local"
          ? "On this computer: no one bills per token; it spends this computer's time and power"
          : "On a server of yours: no one bills per token",
    };
    return {
      installed: true,
      signedIn: found.models.length > 0,
      ...(found.version ? { version: found.version } : {}),
      plan: where === "local" ? "Local" : "Self-hosted",
      billing,
      detail:
        found.models.length === 0
          ? `${connection.name} answers at ${at} but has no model yet. ${this.signIn}`
          : `${connection.name}${found.version ? ` ${found.version}` : ""} at ${at}: ${String(found.models.length)} models${
              found.models.some((m) => m.tools !== undefined)
                ? `, ${String(tools)} take tools`
                : " (whether they take tools is not said)"
            }${found.latencyMs === undefined ? "" : `, answered in ${String(found.latencyMs)} ms`}.`,
    };
  }

  usage(): Promise<ProviderUsage | undefined> {
    return Promise.resolve(undefined);
  }
}

/** A local connection's models, as its server lists them, with what is known of each. */
export class LocalCatalog implements ModelCatalog {
  #models: readonly LocalModel[] = [];

  constructor(private readonly state: LocalState) {}

  /** No tiers are guessed for local models: each takes the connection's default model. */
  get tiers() {
    return { deep: ["default"], standard: ["default"], light: ["default"] };
  }

  async models(): Promise<readonly ModelOption[]> {
    this.#models = (await this.state.discovery()).models;
    return [
      {
        id: "default",
        name: "Default",
        hint: this.state.connection.defaultModel ?? "the server's first suitable model",
      },
      ...this.#models.map((m) => ({ id: m.id, name: m.name, hint: describeModel(m) })),
    ];
  }

  efforts(): readonly string[] {
    return [];
  }

  modelName(id: string): string {
    return this.#models.find((m) => m.id === id)?.name ?? id;
  }
}

/**
 * A local connection's execution: Ollama through its own chat API; LM
 * Studio, Bionic and any other through the shared OpenAI-compatible
 * adapter, streamed. A model known not to take tools is offered none.
 */
export class LocalRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: true,
    keepsConversation: true,
    usageReport: false,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly state: LocalState,
    private readonly settings: LocalSettings = {},
  ) {}

  create(choice: ModelChoice): Model {
    const connection = this.state.connection;
    const wanted =
      choice.model === undefined || choice.model === "default" ? undefined : choice.model;
    const pick = () => (wanted ? this.state.model(wanted) : this.state.defaultModel());
    const inference = connection.inference ?? {};
    const timeoutMs = connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const state = this.state;
    const settings = this.settings;
    // The model is known only once the server is asked: decided when a conversation opens.
    const lazy: Model = {
      name: connection.name,
      async open(options) {
        const where = await state.locality();
        if (typeof where === "object")
          throw new ModelError("setup", `${connection.name}: ${where.refused}`);
        const model = await pick();
        const noTools = model.tools === false;
        const inner: Model =
          connection.kind === "ollama"
            ? new OllamaModel({
                name: connection.name,
                url: rootOf(connection.url),
                model: model.id,
                key: state.key,
                noTools,
                timeoutMs,
                options: {
                  ...(inference.temperature === undefined
                    ? {}
                    : { temperature: inference.temperature }),
                  ...(inference.maxTokens === undefined
                    ? {}
                    : { num_predict: inference.maxTokens }),
                  // The context the model runs with: chosen, else what the model takes up to 32k.
                  num_ctx:
                    inference.contextLength ??
                    Math.min(model.contextLength ?? MIN_AGENT_CONTEXT * 2, 32_768),
                },
                ...(inference.keepAlive ? { keepAlive: inference.keepAlive } : {}),
                ...(settings.fetch ? { fetch: settings.fetch } : {}),
              })
            : new ChatCompletionsModel({
                name: connection.name,
                api: openAiBase(connection),
                model: model.id,
                key: state.key,
                keyOptional: LOCAL_KIND_INFO[connection.kind].key !== "required",
                noKey: `${connection.name} needs a key: set it in /connect.`,
                stream: true,
                noTools,
                timeoutMs,
                inference: {
                  ...(inference.temperature === undefined
                    ? {}
                    : { temperature: inference.temperature }),
                  ...(inference.maxTokens === undefined ? {} : { max_tokens: inference.maxTokens }),
                },
                ...(settings.fetch ? { fetch: settings.fetch } : {}),
              });
        return inner.open(options);
      },
    };
    return resilient(lazy);
  }
}

/** A model server of the person's own: its three parts, as one connection. */
export class LocalProvider extends ComposedProvider {
  readonly state: LocalState;

  constructor(connection: LocalConnection, settings: LocalSettings = {}) {
    const state = new LocalState(connection, settings);
    super(connection.id, connection.name, {
      auth: new LocalAuth(state),
      catalog: new LocalCatalog(state),
      runtime: new LocalRuntime(state, settings),
    });
    this.state = state;
  }
}

/**
 * Whether a local model can take a task the agent does with tools (files,
 * commands): it takes tools, as the server says, and runs with enough
 * context. Unknown is not enough.
 */
export function capableForTools(model: LocalModel, context?: number): boolean {
  const window = context ?? model.contextLength;
  return model.tools === true && (window === undefined || window >= MIN_AGENT_CONTEXT);
}
