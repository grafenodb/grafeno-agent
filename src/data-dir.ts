import { homedir } from "node:os";
import { join } from "node:path";

/** The agent's data folder: runs, worktrees, caches. Never inside a project. */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.GRAFENO_AGENT_DATA) return env.GRAFENO_AGENT_DATA;
  if (process.platform === "win32" && env.LOCALAPPDATA)
    return join(env.LOCALAPPDATA, "grafeno-agent");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "grafeno-agent");
}
