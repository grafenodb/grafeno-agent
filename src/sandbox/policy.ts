/**
 * Grafeno Sandbox's policies: whether commands run in a sandbox, with what
 * network and limits, and the environment they see. Settings, not code.
 */

/**
 * `auto` (the default): in a sandbox where this computer has one; where it
 * has none, on the computer, and every command says so. `required`: never
 * on the computer: a command that cannot be sandboxed does not run.
 * `off`: on the computer, said by `/sandbox status`.
 */
export type SandboxMode = "auto" | "required" | "off";

export function sandboxMode(env: Record<string, string | undefined> = process.env): SandboxMode {
  const value = (env.AGENT_SANDBOX ?? "").trim().toLowerCase();
  return value === "required" || value === "off" ? value : "auto";
}

/** What becomes of a sandbox when its work is done: `never` kept, kept when it `failed`, or `always`. */
export type KeepPolicy = "never" | "failed" | "always";

export function keepPolicy(env: Record<string, string | undefined> = process.env): KeepPolicy {
  const value = (env.AGENT_SANDBOX_KEEP ?? "").trim().toLowerCase();
  return value === "failed" || value === "always" ? value : "never";
}

/** A command's network: `none`, or `open` (the internet, for installing and fetching). */
export type NetworkPolicy = "none" | "open";

/**
 * When commands get the network (`AGENT_SANDBOX_NETWORK`): `auto` (the
 * default) for commands that install or fetch (npm install, pip install,
 * git clone…), none for the rest; `always`; `never`.
 */
export type NetworkSetting = "auto" | "always" | "never";

export function networkSetting(
  env: Record<string, string | undefined> = process.env,
): NetworkSetting {
  const value = (env.AGENT_SANDBOX_NETWORK ?? "").trim().toLowerCase();
  return value === "always" || value === "never" ? value : "auto";
}

/** Commands that need the network to do their job: installing, fetching, cloning. */
const NEEDS_NETWORK: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|up|dlx|create|init)\b/,
  /\bnpx\s/,
  /\b(pip|pip3|uv|poetry|pipenv)\s+(install|add|sync|lock|update)\b/,
  /\b(cargo)\s+(fetch|install|update|add|build|test|run)\b/,
  /\bgo\s+(get|mod\s+download|install|mod\s+tidy)\b/,
  /\b(gem|bundle)\s+(install|update)\b/,
  /\b(composer)\s+(install|update|require)\b/,
  /\b(apt|apt-get|brew|dnf|yum|apk)\s+(install|update)\b/,
  /\bgit\s+(clone|fetch|pull|push|submodule\s+update|ls-remote)\b/,
  /\b(curl|wget)\b/,
  /\b(docker|podman)\s+(pull|build)\b/,
  /\bdotnet\s+(restore|add|tool\s+install)\b/,
  /\b(mvn|gradle|gradlew)\b/,
];

/** The network a command gets under a setting. */
export function networkFor(command: string, setting: NetworkSetting): NetworkPolicy {
  if (setting === "always") return "open";
  if (setting === "never") return "none";
  return NEEDS_NETWORK.some((p) => p.test(command)) ? "open" : "none";
}

/** What a sandbox may use: memory, CPU time, processes, open files, time. */
export interface Limits {
  readonly memoryMb: number;
  readonly cpuSeconds: number;
  readonly processes: number;
  readonly files: number;
}

/**
 * The security profiles, by how much a task may do:
 * - `strict`: a command that only reads or checks (tests, lint, builds):
 *   no network, tight limits;
 * - `standard`: the default for the agent's commands;
 * - `install`: installing dependencies: the network, more memory and time.
 */
export type ProfileName = "strict" | "standard" | "install";

export const PROFILES: Readonly<Record<ProfileName, Limits>> = {
  strict: { memoryMb: 2048, cpuSeconds: 300, processes: 256, files: 1024 },
  standard: { memoryMb: 4096, cpuSeconds: 900, processes: 512, files: 4096 },
  install: { memoryMb: 6144, cpuSeconds: 1800, processes: 1024, files: 8192 },
};

/** The profile a command takes: installing gets `install`, the rest `standard`. */
export function profileFor(command: string, network: NetworkPolicy): ProfileName {
  return network === "open" && NEEDS_NETWORK.some((p) => p.test(command)) ? "install" : "standard";
}

/** Environment variables never given to a sandbox: ways back to the person's sessions and agents. */
export const NEVER_IN_SANDBOX = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "KRB5CCNAME",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
] as const;

/**
 * The environment of a command in a sandbox: the one given, without the
 * variables that lead to the person's sessions, agents and credentials,
 * with its home, temporary folder and package caches in the sandbox, so
 * nothing it installs changes the computer's own.
 */
export function sandboxEnv(
  base: Record<string, string | undefined>,
  sandbox: { readonly home: string; readonly tmp: string },
  join: (...parts: string[]) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const never = new Set<string>(NEVER_IN_SANDBOX);
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || never.has(name)) continue;
    out[name] = value;
  }
  const home = sandbox.home;
  return {
    ...out,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: sandbox.tmp,
    TMP: sandbox.tmp,
    TEMP: sandbox.tmp,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    npm_config_cache: join(home, ".npm"),
    npm_config_prefix: join(home, ".npm-global"),
    npm_config_userconfig: join(home, ".npmrc"),
    YARN_CACHE_FOLDER: join(home, ".cache", "yarn"),
    PNPM_HOME: join(home, ".local", "share", "pnpm"),
    PIP_CACHE_DIR: join(home, ".cache", "pip"),
    PIP_CONFIG_FILE: join(home, ".config", "pip", "pip.conf"),
    CARGO_HOME: join(home, ".cargo"),
    GOPATH: join(home, "go"),
    GOMODCACHE: join(home, "go", "pkg", "mod"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GRAFENO_SANDBOX: "1",
  };
}
