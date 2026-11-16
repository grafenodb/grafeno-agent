import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "../data-dir.js";
import { ClaudeAgentModel, type AgentSdk } from "../model/claude-agent.js";
import { resilient } from "../model/index.js";
import type { Model } from "../model/types.js";
import { claudeModelName, CLAUDE_EFFORTS } from "./claude-code.js";
import { ComposedProvider } from "./compose.js";
import { systemSecretStore, type SecretStore } from "./secrets.js";
import type {
  ModelCatalog,
  ModelChoice,
  ModelOption,
  ProviderAuth,
  ProviderRuntime,
  ProviderStatus,
  ProviderUsage,
} from "./types.js";

/** The SDK versions installed on demand: exact, and at least two weeks old when chosen. */
export const CLAUDE_API_PACKAGES = [
  "@anthropic-ai/claude-agent-sdk@0.3.316",
  "@anthropic-ai/sdk@1.3.0",
] as const;
/** The secret store's account for the key. */
export const CLAUDE_API_ACCOUNT = "anthropic-api-key";

/** Where `grafeno-agent providers install claude-api` puts the SDK: the agent's data folder. */
export function claudeApiPrefix(env: Record<string, string | undefined> = process.env): string {
  return join(dataDir(env), "extensions", "claude-api");
}

/** The client SDK's part this provider uses: listing models (free), to check a key. */
export interface ClientSdk {
  listModels(key: string): Promise<{ id: string; name: string }[]>;
}

export interface ClaudeApiSettings {
  /** Where `ANTHROPIC_API_KEY` and `CLAUDE_API_MAX_BUDGET_USD` are read. */
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  /** Loads the Agent SDK; default: from the project, else from the data folder. */
  readonly agentSdk?: () => Promise<AgentSdk>;
  /** Loads the client SDK; default: likewise. */
  readonly clientSdk?: () => Promise<ClientSdk>;
}

/**
 * A package, from where Node finds it (the repository's devDependencies),
 * else from the data folder it was installed into on demand.
 */
export async function loadPackage(name: string, prefix: string): Promise<unknown> {
  try {
    return (await import(name)) as unknown;
  } catch {
    const root = join(prefix, "node_modules", ...name.split("/"));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
      main?: string;
    };
    const entry = entryOf(manifest);
    if (!entry) throw new Error(`${name} has no entry point`);
    return (await import(pathToFileURL(join(root, entry)).href)) as unknown;
  }
}

function entryOf(manifest: {
  exports?: Record<string, unknown>;
  main?: string;
}): string | undefined {
  const dot = manifest.exports?.["."];
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const record = dot as Record<string, unknown>;
    for (const key of ["import", "default"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return manifest.main;
}

/** The Agent SDK, as the model uses it. */
export function defaultAgentSdk(env: Record<string, string | undefined>): () => Promise<AgentSdk> {
  return async () => {
    const sdk = (await loadPackage("@anthropic-ai/claude-agent-sdk", claudeApiPrefix(env))) as {
      query?: AgentSdk["query"];
    };
    if (typeof sdk.query !== "function") throw new Error("The Agent SDK has no query()");
    return { query: sdk.query.bind(sdk) };
  };
}

/** The client SDK's model list, which checks a key without spending anything. */
export function defaultClientSdk(
  env: Record<string, string | undefined>,
): () => Promise<ClientSdk> {
  return async () => {
    const mod = (await loadPackage("@anthropic-ai/sdk", claudeApiPrefix(env))) as {
      default?: new (options: { apiKey: string }) => {
        models: { list(): AsyncIterable<{ id: string; display_name?: string }> };
      };
    };
    const Anthropic = mod.default;
    if (!Anthropic) throw new Error("The Anthropic SDK has no client");
    return {
      async listModels(key) {
        const client = new Anthropic({ apiKey: key });
        const out: { id: string; name: string }[] = [];
        for await (const model of client.models.list()) {
          out.push({ id: model.id, name: model.display_name ?? model.id });
        }
        return out;
      },
    };
  };
}

/** Where the key comes from: `ANTHROPIC_API_KEY`, else the system's secure store. */
export class ClaudeApiCredential {
  constructor(private readonly settings: ClaudeApiSettings) {}

  async read(): Promise<{ key: string; from: string } | undefined> {
    const env = this.settings.env ?? process.env;
    const value = env.ANTHROPIC_API_KEY?.trim();
    if (value) return { key: value, from: "ANTHROPIC_API_KEY" };
    const store = this.store();
    const stored = await store.get(CLAUDE_API_ACCOUNT).catch(() => undefined);
    return stored ? { key: stored, from: store.name } : undefined;
  }

  key = async (): Promise<string | undefined> => (await this.read())?.key;

  store(): SecretStore {
    return this.settings.store ?? systemSecretStore(dataDir(this.settings.env ?? process.env));
  }
}

/** Whether a failure from the client SDK says the key was refused (HTTP 401 or 403). */
function refused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * claude-api's authentication: an Anthropic API key only (the Agent SDK's
 * documented way for third-party products), never a Claude subscription's
 * sign-in. Always billed per token, so it runs only when the user allows
 * it (AGENT_ALLOW_BILLING=claude-api). The key is checked by listing
 * models, which spends nothing.
 */
export class ClaudeApiAuth implements ProviderAuth {
  readonly method = "api-key";
  readonly signIn =
    "Create an API key in the Claude Console, then run `grafeno-agent login claude-api` (or set ANTHROPIC_API_KEY). It bills per token.";

  constructor(
    private readonly credential: ClaudeApiCredential,
    private readonly client: () => Promise<ClientSdk>,
    private readonly agent: () => Promise<AgentSdk>,
  ) {}

  async status(): Promise<ProviderStatus> {
    try {
      await this.agent();
    } catch {
      return {
        installed: false,
        signedIn: false,
        detail:
          "The Claude Agent SDK is not installed: grafeno-agent providers install claude-api (a native program of about 335 MB once unpacked).",
      };
    }
    const found = await this.credential.read();
    if (!found) return { installed: true, signedIn: false, detail: this.signIn };
    let checked = true;
    try {
      const client = await this.client();
      await client.listModels(found.key);
    } catch (error) {
      if (refused(error)) {
        return {
          installed: true,
          signedIn: false,
          detail: `Anthropic refused the API key from ${found.from}. ${this.signIn}`,
        };
      }
      checked = false;
    }
    return {
      installed: true,
      signedIn: true,
      plan: "Anthropic API",
      billing: { kind: "metered", detail: "The Anthropic API, billed per token" },
      detail: `Key from ${found.from}${checked ? "" : " (not checked: the API was not reachable)"}. Billed per token: it runs only with AGENT_ALLOW_BILLING=claude-api.`,
    };
  }

  /** The API reports no spending for a key without an admin key: costs come with each turn. */
  usage(): Promise<ProviderUsage | undefined> {
    return Promise.resolve(undefined);
  }
}

/** claude-api's model selection: the API's models, by the same family aliases. */
export class ClaudeApiCatalog implements ModelCatalog {
  readonly tiers = {
    deep: ["opus", "sonnet"],
    standard: ["sonnet", "opus"],
    light: ["haiku", "sonnet"],
  } as const;
  readonly #names = new Map<string, string>();

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly client: () => Promise<ClientSdk>,
  ) {}

  async models(): Promise<readonly ModelOption[]> {
    const families: ModelOption[] = [
      { id: "default", name: "Auto", hint: "the SDK's default model" },
      { id: "haiku", name: "Haiku", hint: "fastest, cheapest" },
      { id: "sonnet", name: "Sonnet", hint: "balanced" },
      { id: "opus", name: "Opus", hint: "most capable, most expensive" },
    ];
    const key = await this.key();
    if (!key) return families;
    try {
      const listed = await (await this.client()).listModels(key);
      for (const m of listed) this.#names.set(m.id, m.name);
      return [...families, ...listed.map((m) => ({ id: m.id, name: m.name }))];
    } catch {
      return families;
    }
  }

  efforts(): readonly string[] {
    return CLAUDE_EFFORTS;
  }

  modelName(id: string): string {
    return this.#names.get(id) ?? claudeModelName(id);
  }
}

/** claude-api's execution: the Agent SDK's agent loop, with the agent's tools over MCP. */
export class ClaudeApiRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: true,
    // A turn resumes the SDK's session: a cancelled one leaves it able to go on.
    keepsConversation: true,
    usageReport: false,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly key: () => Promise<string | undefined>,
    private readonly agent: () => Promise<AgentSdk>,
    private readonly settings: ClaudeApiSettings,
  ) {}

  create(choice: ModelChoice): Model {
    const env = this.settings.env ?? process.env;
    const budget = Number(env.CLAUDE_API_MAX_BUDGET_USD);
    return resilient(
      new ClaudeAgentModel({
        ...(choice.model === undefined || choice.model === "default"
          ? {}
          : { model: choice.model }),
        ...(choice.effort === undefined ? {} : { effort: choice.effort }),
        key: this.key,
        sdk: this.agent,
        env,
        ...(Number.isFinite(budget) && budget > 0 ? { maxBudgetUsd: budget } : {}),
      }),
    );
  }
}

/** Claude through the official Agent SDK and the user's API key: its three parts. */
export class ClaudeApiProvider extends ComposedProvider {
  constructor(settings: ClaudeApiSettings = {}) {
    const env = settings.env ?? process.env;
    const credential = new ClaudeApiCredential(settings);
    const agent = settings.agentSdk ?? defaultAgentSdk(env);
    const client = settings.clientSdk ?? defaultClientSdk(env);
    super("claude-api", "Claude Agent (API key)", {
      auth: new ClaudeApiAuth(credential, client, agent),
      catalog: new ClaudeApiCatalog(credential.key, client),
      runtime: new ClaudeApiRuntime(credential.key, agent, settings),
    });
  }
}

/** The npm that comes with this Node, run with Node: no shell parses the arguments. */
function npmCommand(execPath = process.execPath): { command: string; prefix: string[] } {
  const cli = [
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => existsSync(path));
  return cli ? { command: execPath, prefix: [cli] } : { command: "npm", prefix: [] };
}

/**
 * Installs the pinned SDKs into the data folder (`providers install
 * claude-api`), with the npm of this Node; resolves with npm's exit code.
 */
export function installClaudeApi(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const prefix = claudeApiPrefix(env);
  mkdirSync(prefix, { recursive: true });
  const npm = npmCommand();
  return new Promise((resolve) => {
    const child = spawn(
      npm.command,
      [
        ...npm.prefix,
        "install",
        "--prefix",
        prefix,
        "--save-exact",
        "--no-fund",
        ...CLAUDE_API_PACKAGES,
      ],
      { stdio: "inherit", windowsHide: true },
    );
    child.on("error", () => {
      resolve(127);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
