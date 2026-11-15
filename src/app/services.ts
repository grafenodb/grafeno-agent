import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, INCLUDED_GRAFENO_URL, loadConfig, type Config } from "../config.js";
import { LOCAL_MODELS, localEmbedder } from "../embed/local.js";
import type { Embedder } from "../embed/types.js";
import {
  includedAsset,
  includedInstalled,
  installIncluded,
  makeAgentKey,
  newOwnerToken,
  startIncluded,
  stopIncluded,
} from "../grafeno/included.js";
import { describeUpkeep, upkeep } from "../memory/upkeep.js";
import { allProviders } from "../providers/index.js";
import type { ModelChoice, Provider } from "../providers/types.js";
import { settingsPath, updateSettings } from "../settings-file.js";
import { checkGrafeno } from "../startup.js";
import { AgentSession } from "./session.js";
import type { Orchestrator, OrchestratorOptions } from "../orchestrator/orchestrator.js";

/** What the interface shows about the Grafeno the agent uses. */
export interface GrafenoInfo {
  readonly mode: "included" | "external";
  readonly url: string;
  readonly namespace: string;
  readonly hasKey: boolean;
  /** This computer has a build of Grafeno to include. */
  readonly includable: boolean;
  /** The included Grafeno is installed here. */
  readonly installed: boolean;
}

/** A Grafeno server the user already has. */
export interface ServerValues {
  readonly url: string;
  /** A new key; absent to keep the one in the settings. */
  readonly key?: string;
  readonly namespace: string;
}

/** What the interface needs from the rest of the program. */
export interface AppServices {
  readonly version: string;
  readonly settingsPath: string;
  /** Where the reasoning can come from: Claude today, more later. */
  readonly providers: readonly Provider[];
  /** No memory is set up yet: the first run asks how. */
  needsSetup(): boolean;
  /** Starts a session with the settings as they are; throws saying why it cannot. */
  start(): Promise<AgentSession>;
  grafeno(): GrafenoInfo;
  /** Installs and starts the included Grafeno, makes the agent's key and saves it all. */
  includeGrafeno(onProgress?: (done: number, total: number) => void): Promise<string>;
  /** Checks a Grafeno server the user already has, and saves it. */
  connectGrafeno(values: ServerValues): Promise<string>;
  /** Stops the included Grafeno, in a line. */
  stopGrafeno(): string;
  /** Keeps the model and effort chosen, for the next sessions. */
  saveChoice(choice: { model?: string; effort?: string; provider?: string }): void;
  /** The memory upkeep report for the session's project. */
  upkeep(session: AgentSession): Promise<string>;
  /** An orchestrator for the project, on the settings, wired to the interface. */
  orchestrator(extra: Partial<OrchestratorOptions>): Promise<Orchestrator>;
}

/** The embedder the settings name, when it can run here; `say` tells the user what happens. */
export async function embedderFor(
  name: string,
  say: (text: string) => void = console.log,
): Promise<Embedder | undefined> {
  if (name !== "e5-small") return undefined;
  try {
    await import("@huggingface/transformers");
  } catch {
    say(
      "Meaning is off: @huggingface/transformers is not installed, so memory works by words alone.",
    );
    return undefined;
  }
  const model = LOCAL_MODELS["e5-small"].id.split("/");
  if (!existsSync(join(homedir(), ".cache", "grafeno-agent", "models", ...model))) {
    say("The meaning model is downloaded once, on first use (about 130 MB).");
  }
  return localEmbedder("e5-small");
}

/** Starts the included Grafeno when the settings use it; nothing otherwise. */
export async function prepareGrafeno(config: Config, env = process.env): Promise<void> {
  if (config.grafenoMode !== "included") return;
  const owner = env.GRAFENO_OWNER_TOKEN?.trim();
  if (!owner) throw new Error("The included Grafeno has no owner token yet: /palace sets it up.");
  await startIncluded(owner);
}

/** The interface's services, on the real settings, Grafeno and providers. */
export function realServices(version: string): AppServices {
  let embedder: Promise<Embedder | undefined> | undefined;
  const env = process.env;
  // Every known provider, the chosen ones (AGENT_PROVIDERS) first: the chat uses the first.
  const providers: Provider[] = allProviders(env);

  /** Saves settings to the file and to this run. */
  const save = (values: Record<string, string>) => {
    updateSettings(values);
    for (const [name, value] of Object.entries(values)) {
      if (value === "") Reflect.deleteProperty(env, name);
      else env[name] = value;
    }
  };

  return {
    version,
    settingsPath: settingsPath(),
    providers,
    needsSetup() {
      const mode = env.GRAFENO_MODE?.trim();
      if (mode === "included") return !env.GRAFENO_OWNER_TOKEN?.trim() || !includedInstalled();
      return !env.GRAFENO_AGENT_KEY?.trim();
    },
    async start() {
      const config = loadConfig();
      await prepareGrafeno(config);
      const report = await checkGrafeno(config);
      embedder ??= embedderFor(config.embedder, () => undefined);
      const chosen = await embedder;
      return AgentSession.start({
        config,
        provider: providers[0] as Provider,
        ...(report.identity ? { identity: report.identity } : {}),
        ...(chosen ? { embedder: chosen } : {}),
      });
    },
    grafeno() {
      const included = env.GRAFENO_MODE?.trim() === "included";
      return {
        mode: included ? "included" : "external",
        url: included ? INCLUDED_GRAFENO_URL : env.GRAFENO_URL?.trim() || DEFAULTS.grafenoUrl,
        namespace: env.GRAFENO_NAMESPACE?.trim() || DEFAULTS.namespace,
        hasKey: (env.GRAFENO_AGENT_KEY?.trim() ?? "") !== "",
        includable: includedAsset() !== undefined,
        installed: includedInstalled(),
      };
    },
    async includeGrafeno(onProgress) {
      await installIncluded(onProgress ? { onProgress } : {});
      const owner = env.GRAFENO_OWNER_TOKEN?.trim() || newOwnerToken();
      const url = await startIncluded(owner);
      const namespace = env.GRAFENO_NAMESPACE?.trim() || DEFAULTS.namespace;
      const key = await makeAgentKey(url, owner, namespace);
      save({
        GRAFENO_MODE: "included",
        GRAFENO_OWNER_TOKEN: owner,
        GRAFENO_AGENT_KEY: key,
        GRAFENO_NAMESPACE: namespace,
      });
      return `Grafeno is included and running at ${url}, namespace "${namespace}". Saved in ${settingsPath()}.`;
    },
    async connectGrafeno(values) {
      const candidate = loadConfig({
        ...env,
        GRAFENO_MODE: "external",
        GRAFENO_URL: values.url,
        GRAFENO_NAMESPACE: values.namespace,
        ...(values.key === undefined ? {} : { GRAFENO_AGENT_KEY: values.key }),
      });
      const report = await checkGrafeno(candidate);
      save({
        GRAFENO_MODE: "external",
        GRAFENO_URL: candidate.grafenoUrl,
        GRAFENO_NAMESPACE: candidate.namespace,
        ...(values.key === undefined ? {} : { GRAFENO_AGENT_KEY: candidate.agentKey }),
      });
      const who = report.identity ? ` as "${report.identity.name}"` : "";
      return `Connected to Grafeno ${report.serverVersion} at ${candidate.grafenoUrl}, namespace "${candidate.namespace}"${who}. Saved in ${settingsPath()}.`;
    },
    stopGrafeno() {
      return stopIncluded()
        ? "The included Grafeno was stopped. It starts again with the next session."
        : "The included Grafeno was not running from here.";
    },
    saveChoice(choice: ModelChoice & { provider?: string }) {
      if (choice.provider !== undefined) {
        // The chosen provider first; the model and effort are its own again.
        const order = providers.map((p) => p.id);
        const rest = order.filter((id) => id !== choice.provider);
        save({
          AGENT_PROVIDERS: [choice.provider, ...rest].join(","),
          CLAUDE_MODEL: "",
          AGENT_EFFORT: "",
        });
        return;
      }
      save({
        ...(choice.model === undefined
          ? {}
          : { CLAUDE_MODEL: choice.model === "default" ? "" : choice.model }),
        ...(choice.effort === undefined
          ? {}
          : { AGENT_EFFORT: choice.effort === "default" ? "" : choice.effort }),
      });
    },
    async orchestrator(extra) {
      // Loaded when used: the orchestrator is not needed to chat.
      const { createOrchestrator } = await import("./orchestrate.js");
      return createOrchestrator({}, extra);
    },
    async upkeep(session: AgentSession) {
      const report = await upkeep({
        vault: session.vault,
        palace: session.memory.palace,
        projectId: session.memory.projectId,
      });
      await session.memory.markUpkeep();
      return describeUpkeep(report);
    },
  };
}
