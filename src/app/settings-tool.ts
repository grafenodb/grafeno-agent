import type { Tool } from "../agent/tools.js";

/** The tool a model uses to read and change the agent's own settings. */
export const SETTINGS_TOOL = "agent_settings";

/** What a model may change, and nothing else. */
export const SETTING_KEYS = [
  "mode",
  "provider",
  "model",
  "effort",
  "auto_providers",
  "leader",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** The settings as a model may read them: never a key, a token or a secret. */
export interface SettingsSnapshot {
  readonly mode: "auto" | "specific";
  /** The chat's provider ("none": no model). */
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly auto_providers: readonly string[];
  /** "provider/model", or "" for none. */
  readonly leader: string;
  /** Each connection, and whether it is usable now. */
  readonly providers: readonly { readonly id: string; readonly state: string }[];
  /** The chat's provider's models and efforts. */
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

/**
 * Where the tool reads the settings and changes them: the interface's own
 * functions, so a change by a model follows the same rules as one by the
 * person (Auto never on with nothing ready, a switched-off connection never
 * used, the leader among Auto's providers).
 */
export interface SettingsPort {
  read(): SettingsSnapshot;
  /** Applies a change already checked; resolves to what happened, in a sentence. */
  apply(key: SettingKey, value: string | readonly string[]): Promise<string>;
}

/** What is never changed by a model, and where the person changes it. */
const REFUSED =
  "Only mode, provider, model, effort, auto_providers and leader can be changed here. Keys, billing, permissions, the sandbox and Grafeno are the person's to change (/connect, /permissions, /sandbox, /palace).";

/** Checks a change against what exists now; a sentence saying why not, or nothing. */
export function checkSetting(
  key: string,
  value: unknown,
  now: SettingsSnapshot,
): string | undefined {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) return `${key}: ${REFUSED}`;
  const known = new Set(now.providers.map((p) => p.id));
  if (key === "auto_providers") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return "auto_providers takes a list of provider ids.";
    }
    const ids = value as string[];
    if (ids.length === 0) return "Auto needs at least one provider.";
    const unknown = ids.filter((id) => !known.has(id));
    return unknown.length > 0 ? `Unknown providers: ${unknown.join(", ")}.` : undefined;
  }
  if (typeof value !== "string") return `${key} takes a text value.`;
  switch (key) {
    case "mode":
      return value === "auto" || value === "specific" ? undefined : 'mode is "auto" or "specific".';
    case "provider":
      return value === "none" || known.has(value)
        ? undefined
        : `Unknown provider ${value}: one of ${[...known].join(", ")}, or none.`;
    case "model":
      return now.models.includes(value)
        ? undefined
        : `${value} is not one of ${now.provider}'s models: ${now.models.join(", ") || "none listed"}.`;
    case "effort":
      return now.efforts.includes(value) || value === "default"
        ? undefined
        : `${value} is not one of ${now.provider}'s efforts: ${[...now.efforts, "default"].join(", ")}.`;
    case "leader": {
      if (value === "") return undefined;
      const provider = value.split("/")[0] ?? "";
      if (!known.has(provider)) return `Unknown provider in the leader: ${provider}.`;
      return now.auto_providers.includes(provider)
        ? undefined
        : `The leader must be one of Auto's providers (${now.auto_providers.join(", ")}).`;
    }
    default:
      return REFUSED;
  }
}

/**
 * The agent's own settings, for a model: `get` reads them (no secret in
 * them); `set` changes one, and the person approves each change. A change
 * is checked against what exists now and applied through the interface,
 * with the same rules as the person's own.
 */
export function settingsTool(port: () => SettingsPort | undefined): Tool {
  return {
    name: SETTINGS_TOOL,
    description: [
      "Reads or changes the agent's own settings: the mode (Auto or a specific provider), the chat's provider and model, how hard it thinks (effort), which providers Auto includes, and the leader of orchestrated runs.",
      'action "get" returns them, with each connection\'s state and the models there are. action "set" changes one key; the person approves it first.',
      "Keys, billing, permissions, the sandbox and Grafeno are never changed here: they are the person's.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        key: { type: "string", enum: [...SETTING_KEYS] },
        value: {
          description:
            'The new value: "auto"/"specific" for mode, a provider id (or "none"), a model id, an effort, a list of provider ids for auto_providers, "provider/model" (or "") for leader.',
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["action"],
    },
    writes: true,
    permission: (input) =>
      input.action === "get"
        ? { permission: "free", reason: "reads the settings" }
        : { permission: "ask", reason: "changes the agent's own settings" },
    describe: (input) =>
      input.action === "get"
        ? "Read the agent's settings"
        : `Change the agent's settings: ${String(input.key)} = ${JSON.stringify(input.value)}`,
    async run(input) {
      const settings = port();
      if (!settings) return "The settings cannot be reached here.";
      if (input.action === "get") return JSON.stringify(settings.read(), null, 2);
      if (input.action !== "set") return 'action is "get" or "set".';
      const key = typeof input.key === "string" ? input.key : "";
      const problem = checkSetting(key, input.value, settings.read());
      if (problem) return problem;
      return settings.apply(key as SettingKey, input.value as string | readonly string[]);
    },
  };
}
