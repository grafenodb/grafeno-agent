import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the agent's settings file is: `GRAFENO_AGENT_CONFIG` when set, else
 * `%APPDATA%\grafeno-agent\config.env` on Windows and
 * `$XDG_CONFIG_HOME/grafeno-agent/config.env` (or `~/.config/...`) elsewhere.
 */
export function settingsPath(env: Record<string, string | undefined> = process.env): string {
  if (env.GRAFENO_AGENT_CONFIG) return env.GRAFENO_AGENT_CONFIG;
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "grafeno-agent", "config.env");
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "grafeno-agent", "config.env");
}

export interface LoadedSettings {
  /** The files read, in order (earlier ones win; real environment variables win over all). */
  readonly files: readonly string[];
}

/**
 * Loads the settings into the environment, without overriding variables
 * already set. From an installed package, only the settings file is read:
 * never the `.env` of the folder it runs in, which belongs to the user's
 * project. Run from the source (development), `./.env` is read first.
 */
export function loadSettings(options: { fromSource: boolean }): LoadedSettings {
  const files: string[] = [];
  if (options.fromSource && existsSync(".env")) {
    process.loadEnvFile(".env");
    files.push(".env");
  }
  const path = settingsPath();
  if (existsSync(path)) {
    process.loadEnvFile(path);
    files.push(path);
  }
  return { files };
}

/** The settings file a new user starts from. */
export function settingsTemplate(): string {
  const example = new URL("../.env.example", import.meta.url);
  if (existsSync(example)) return readFileSync(example, "utf8");
  return "GRAFENO_URL=http://127.0.0.1:7810\nGRAFENO_AGENT_KEY=\nGRAFENO_NAMESPACE=grafeno-agent\n";
}

/**
 * Writes the settings file from the template, readable by its owner only.
 * Returns false when one is already there (it is never overwritten).
 */
export function initSettings(path = settingsPath()): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, settingsTemplate(), { mode: 0o600 });
  return true;
}
