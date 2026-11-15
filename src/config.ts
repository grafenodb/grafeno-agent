import { parseLimits, type RetrievalLimits } from "./memory/budget.js";

/** The agent's settings, read from the environment. */
export interface Config {
  /**
   * `included`: the Grafeno the agent installs and runs itself (on
   * 127.0.0.1:7811); `external`: a Grafeno server at `grafenoUrl`.
   */
  readonly grafenoMode: GrafenoMode;
  /** Base URL of the Grafeno server, without a trailing slash. */
  readonly grafenoUrl: string;
  /** The agent's own Grafeno key. A secret: never log or store it. */
  readonly agentKey: string;
  /** The namespace the agent keeps its memory in. */
  readonly namespace: string;
  /** Which model the agent reasons with (an adapter name, such as `claude-code`). */
  readonly model: string;
  /** For `claude-code`: the Claude model alias (`haiku`, `sonnet`, `opus`…); unset: Claude Code's own. */
  readonly claudeModel?: string;
  /** For `claude-code`: the effort (`low` … `max`); unset: Claude Code's own. */
  readonly claudeEffort?: string;
  /** The project the agent works on; unset: the git repository (or folder) it runs in. */
  readonly project?: string;
  /** The embedder for meaning (`e5-small`, local), or `none` for words alone. */
  readonly embedder: string;
  /**
   * Whose palace the agent keeps the project's memory in: `shared`, the
   * project's own, which every agent on it uses; or `own`, a palace of this
   * agent alone ("<project> · <agent>"), for agents that do not work together.
   */
  readonly palace: PalaceMode;
  /**
   * How much memory may reach the model, from `AGENT_MEMORY_BUDGET`
   * (`checkpoint=400,session=10000`, …); unset limits keep their defaults.
   */
  readonly memoryLimits?: Partial<RetrievalLimits>;
}

/** The palaces `AGENT_PALACE` may name. */
export const PALACES = ["shared", "own"] as const;
export type PalaceMode = (typeof PALACES)[number];

/** Where Grafeno comes from, as `GRAFENO_MODE` names it. */
export const GRAFENO_MODES = ["external", "included"] as const;
export type GrafenoMode = (typeof GRAFENO_MODES)[number];

/** Where the included Grafeno listens. */
export const INCLUDED_GRAFENO_URL = "http://127.0.0.1:7811";

/** The efforts `AGENT_EFFORT` may name. */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The embedders `AGENT_EMBEDDER` may name. */
export const EMBEDDERS = ["e5-small", "none"] as const;

export const DEFAULTS = {
  grafenoUrl: "http://127.0.0.1:7810",
  namespace: "grafeno-agent",
  model: "claude-code",
  // Measured: with meaning, the right memory reaches the model 93% of the
  // time instead of 63% (docs/measurements/meaning-2026-11-14.md).
  embedder: "e5-small",
  palace: "shared",
} as const;

/** The settings are missing or wrong; `problems` says each one. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid settings:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function read(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Reads and checks the settings; throws a `ConfigError` listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];

  const mode = read(env, "GRAFENO_MODE") ?? "external";
  if (!(GRAFENO_MODES as readonly string[]).includes(mode)) {
    problems.push(`GRAFENO_MODE must be one of ${GRAFENO_MODES.join(", ")}: ${mode}`);
  }
  const rawUrl =
    mode === "included" ? INCLUDED_GRAFENO_URL : (read(env, "GRAFENO_URL") ?? DEFAULTS.grafenoUrl);
  let grafenoUrl = rawUrl;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push(`GRAFENO_URL must be http or https, not ${url.protocol}`);
    }
    grafenoUrl = rawUrl.replace(/\/+$/, "");
  } catch {
    problems.push(`GRAFENO_URL is not a URL: ${rawUrl}`);
  }

  const agentKey = read(env, "GRAFENO_AGENT_KEY");
  if (agentKey === undefined) {
    problems.push("GRAFENO_AGENT_KEY is not set (an administrator makes it: grafeno keys create)");
  }

  const namespace = read(env, "GRAFENO_NAMESPACE") ?? DEFAULTS.namespace;
  if (!NAMESPACE.test(namespace)) {
    problems.push(
      `GRAFENO_NAMESPACE must be letters, digits, '.', '_' or '-', starting with a letter or digit: ${namespace}`,
    );
  }

  const model = read(env, "AGENT_MODEL") ?? DEFAULTS.model;
  const claudeModel = read(env, "CLAUDE_MODEL");
  const claudeEffort = read(env, "AGENT_EFFORT");
  if (claudeEffort !== undefined && !EFFORTS.includes(claudeEffort)) {
    problems.push(`AGENT_EFFORT must be one of ${EFFORTS.join(", ")}: ${claudeEffort}`);
  }
  const project = read(env, "AGENT_PROJECT");
  const embedder = read(env, "AGENT_EMBEDDER") ?? DEFAULTS.embedder;
  if (!(EMBEDDERS as readonly string[]).includes(embedder)) {
    problems.push(`AGENT_EMBEDDER must be one of ${EMBEDDERS.join(", ")}: ${embedder}`);
  }

  const palace = read(env, "AGENT_PALACE") ?? DEFAULTS.palace;
  if (!(PALACES as readonly string[]).includes(palace)) {
    problems.push(`AGENT_PALACE must be one of ${PALACES.join(", ")}: ${palace}`);
  }

  const budgetText = read(env, "AGENT_MEMORY_BUDGET");
  const budget = budgetText === undefined ? undefined : parseLimits(budgetText);
  if (budget) problems.push(...budget.problems);

  if (problems.length > 0 || agentKey === undefined) throw new ConfigError(problems);
  return {
    grafenoMode: mode as GrafenoMode,
    grafenoUrl,
    agentKey,
    namespace,
    model,
    embedder,
    palace: palace as PalaceMode,
    ...(claudeModel === undefined ? {} : { claudeModel }),
    ...(claudeEffort === undefined ? {} : { claudeEffort }),
    ...(project === undefined ? {} : { project }),
    ...(budget && Object.keys(budget.limits).length > 0 ? { memoryLimits: budget.limits } : {}),
  };
}

/** The settings as text safe to print: the key is masked. */
export function describeConfig(config: Config): string {
  return [
    `server:    ${config.grafenoUrl}${config.grafenoMode === "included" ? " (included)" : ""}`,
    `namespace: ${config.namespace}`,
    `model:     ${config.model}${config.claudeModel === undefined ? "" : ` (${config.claudeModel})`}`,
    `meaning:   ${config.embedder}`,
    `palace:    ${config.palace}`,
    `key:       ${maskSecret(config.agentKey)}`,
  ].join("\n");
}

/** Shows only enough of a secret to tell which one it is. */
export function maskSecret(secret: string): string {
  return secret.length <= 8 ? "********" : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}
