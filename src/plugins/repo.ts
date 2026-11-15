import { execFile } from "node:child_process";

/** A repository named by a git remote: its host and its path (owner/name, or group/…/name). */
export interface RemoteRepo {
  readonly host: string;
  readonly path: string;
}

/** The host and path of a remote URL (https or ssh); undefined when it is not one. */
export function parseRemote(url: string): RemoteRepo | undefined {
  const trimmed = url.trim();
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh?.[1] && ssh[2] && !trimmed.startsWith("http")) {
    return { host: ssh[1].toLowerCase(), path: ssh[2] };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git\/?$|\/$/g, "");
    return path.includes("/") ? { host: parsed.hostname.toLowerCase(), path } : undefined;
  } catch {
    return undefined;
  }
}

/** The project's git remotes (origin first), each parsed. */
export function projectRemotes(root: string): Promise<RemoteRepo[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["remote", "-v"],
      { cwd: root, timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const found = new Map<string, RemoteRepo>();
        const lines = stdout
          .split(/\r?\n/)
          .sort((a, b) => Number(b.startsWith("origin")) - Number(a.startsWith("origin")));
        for (const line of lines) {
          const url = line.split(/\s+/)[1];
          const repo = url ? parseRemote(url) : undefined;
          if (repo) found.set(`${repo.host}/${repo.path}`, repo);
        }
        resolve([...found.values()]);
      },
    );
  });
}
