import { updateSettings } from "../settings-file.js";
import { enabledPluginIds, KNOWN_PLUGINS, PLUGINS_SETTING, type Plugin } from "../plugins/index.js";

export interface PluginsCommandOptions {
  readonly say: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
  /** Saves settings; default: the settings file. */
  readonly save?: (values: Record<string, string>) => void;
  /** Makes a plugin; default: the real ones. */
  readonly make?: (id: string) => Plugin;
}

const USAGE = `grafeno-agent plugins                  each plugin: on or off, connected or not, and its terms
grafeno-agent plugins enable <id>      turn one on (it is checked first: --force turns it on anyway)
grafeno-agent plugins disable <id>     turn one off
Plugins: ${Object.keys(KNOWN_PLUGINS).join(", ")}. They are off until you turn them on.`;

/**
 * `grafeno-agent plugins …`: the external services (GitHub, GitLab) the
 * agent may work with, each with the service's own documented sign-in.
 */
export async function pluginsCommand(
  args: readonly string[],
  options: PluginsCommandOptions,
): Promise<number> {
  const { say } = options;
  const env = options.env ?? process.env;
  const make =
    options.make ?? ((id: string) => (KNOWN_PLUGINS[id] as (e: typeof env) => Plugin)(env));
  const save =
    options.save ??
    ((values: Record<string, string>) => {
      updateSettings(values);
    });
  const sub = args[0] ?? "list";
  const enabled = enabledPluginIds(env);
  const write = (ids: string[]) => {
    const value = ids.join(",");
    save({ [PLUGINS_SETTING]: value });
    env[PLUGINS_SETTING] = value;
  };

  switch (sub) {
    case "list":
    case "ls": {
      for (const id of Object.keys(KNOWN_PLUGINS)) {
        const plugin = make(id);
        const status = await plugin.status();
        say(
          `${enabled.includes(id) ? "[on] " : "[off]"} ${plugin.name.padEnd(8)} ${status.ready ? "✓" : "✗"} ${status.detail}`,
        );
        say(`        ${plugin.description}`);
        for (const term of plugin.terms) say(`        · ${term}`);
        if (!status.ready) say(`        To connect: ${plugin.connect}`);
      }
      say("");
      say(USAGE);
      return 0;
    }
    case "enable":
    case "on": {
      const id = (args[1] ?? "").toLowerCase();
      if (!(id in KNOWN_PLUGINS)) {
        say(`No plugin is named ${args[1] ?? "(nothing)"}.`);
        say(USAGE);
        return 2;
      }
      const plugin = make(id);
      const status = await plugin.status();
      if (!status.ready && !args.includes("--force")) {
        say(`${plugin.name} is not connected: ${status.detail}`);
        say(`To connect: ${plugin.connect}`);
        say("Not turned on (--force turns it on anyway).");
        return 1;
      }
      if (!enabled.includes(id)) write([...enabled, id]);
      say(`${plugin.name} is on. ${status.detail}`);
      for (const term of plugin.terms) say(`· ${term}`);
      say(
        "Its tools reach the agent from its next session: reading runs at once, anything that changes something asks you first.",
      );
      return 0;
    }
    case "disable":
    case "off": {
      const id = (args[1] ?? "").toLowerCase();
      if (!enabled.includes(id)) {
        say(`${args[1] ?? "(nothing)"} is not on.`);
        return 1;
      }
      write(enabled.filter((x) => x !== id));
      say(`${make(id).name} is off.`);
      return 0;
    }
    default:
      say(USAGE);
      return sub === "help" || sub === "--help" ? 0 : 2;
  }
}
