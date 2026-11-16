import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Limits, NetworkPolicy } from "./policy.js";

/** What a command in a sandbox may touch, and use. */
export interface SandboxPolicy {
  /** Folders and files it may write (and read). */
  readonly writable: readonly string[];
  /** Folders and files it may only read (and run). */
  readonly readable: readonly string[];
  readonly network: NetworkPolicy;
  readonly limits: Limits;
}

/** Where a sandbox keeps its own things: its home and temporary folder. */
export interface SandboxPlace {
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
}

/**
 * What a sandbox really applied to one command, as the engine reported it;
 * a mechanism is true only when it was applied, never assumed.
 */
export interface Isolation {
  readonly engine: "linux" | "macos" | "none";
  /** Files outside what it may read and write are out of its reach. */
  readonly files: boolean;
  /** `none`: no network at all; `tcp-blocked`: no TCP; `open`: the network as the computer has it. */
  readonly network: "none" | "tcp-blocked" | "open";
  /** Its processes cannot see or signal the computer's (a PID namespace). */
  readonly processes: boolean;
  /** System calls that could undo the sandbox are refused (seccomp). */
  readonly syscalls: boolean;
  /** Memory, CPU, processes and files are limited (cgroups or resource limits). */
  readonly limits: boolean;
  /** Each mechanism applied, by name. */
  readonly mechanisms: readonly string[];
}

/** What an engine can do on this computer, found by asking it (never assumed). */
export interface EngineReport {
  readonly engine: "linux" | "macos" | "none";
  readonly available: boolean;
  /** Why it is not available, when it is not. */
  readonly reason?: string;
  readonly mechanisms: readonly string[];
  readonly limitations: readonly string[];
  readonly helper?: string;
}

/** How to start a command in the sandbox: the program, its arguments, and where its report comes. */
export interface Wrapped {
  readonly file: string;
  readonly args: readonly string[];
  /** The descriptor (3) the engine writes its report on, as one JSON line. */
  readonly reportFd?: number;
}

export interface IsolationEngine {
  readonly name: "linux" | "macos" | "none";
  probe(): Promise<EngineReport>;
  wrap(argv: readonly [string, ...string[]], policy: SandboxPolicy, place: SandboxPlace): Wrapped;
  /** What was applied, from the engine's report (or none, for engines without one). */
  isolation(report: string | undefined, policy: SandboxPolicy): Isolation;
}

/** The package's own folder (where `vendor/` is), from this file's place in `dist/sandbox/`. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Folders a command reads to run at all: the system's programs and libraries, and its settings. */
const SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/proc",
  "/sys",
  "/run",
  "/var/lib",
  "/nix",
  "/snap",
];

/**
 * What a command may read besides the system: Node's own installation (it
 * runs npm and node), and the folders of PATH outside the home folder or in
 * known places for programs under it (never the home folder itself).
 */
export function programFolders(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string[] {
  const node = dirname(dirname(process.execPath));
  const out = new Set<string>([node]);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry === "" || !entry.startsWith(sep)) continue;
    const dir = resolve(entry);
    if (dir === home || dir === `${home}${sep}bin`) continue;
    // Under the home folder only the places programs are installed in.
    if (dir.startsWith(`${home}${sep}`)) {
      const rel = dir.slice(home.length + 1);
      if (
        !/^(\.local|\.cargo|\.nvm|\.volta|\.bun|\.deno|\.pyenv|\.rbenv|go|\.npm-global|\.fnm|\.asdf|\.sdkman)(\/|$)/.test(
          rel,
        )
      ) {
        continue;
      }
      // The program folder's parent too (its libraries), not the home folder.
      out.add(rel.includes(sep) ? dirname(dir) : dir);
    }
    out.add(dir);
  }
  return [...out];
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The helper's integrity, checked once: its hash against the package's manifest. */
const verified = new Map<string, string | undefined>();

/**
 * The Linux helper for this machine, from the package (vendor/sandbox),
 * checked against the manifest the release wrote; or the one
 * `GRAFENO_SANDBOX_HELPER` names (a build of one's own, said in the report).
 * Returns the path, or why there is none.
 */
export function linuxHelper(
  env: Record<string, string | undefined> = process.env,
  root = packageRoot(),
): { path: string; own: boolean } | { problem: string } {
  const own = env.GRAFENO_SANDBOX_HELPER?.trim();
  if (own) {
    try {
      accessSync(own, constants.X_OK);
      return { path: own, own: true };
    } catch {
      return { problem: `GRAFENO_SANDBOX_HELPER (${own}) is not an executable file` };
    }
  }
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!arch) return { problem: `no sandbox helper is built for ${process.arch}` };
  const relative = `linux-${arch}/grafeno-sandbox`;
  const path = join(root, "vendor", "sandbox", relative);
  if (!existsSync(path)) {
    return { problem: `the sandbox helper is not in this installation (${path})` };
  }
  const cached = verified.get(path);
  if (cached !== undefined || verified.has(path)) {
    return cached === undefined ? { path, own: false } : { problem: cached };
  }
  let problem: string | undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "vendor", "sandbox", "manifest.json"), "utf8"),
    ) as { files?: Record<string, string> };
    const expected = manifest.files?.[relative];
    if (!expected) problem = "the sandbox helper is not in the package's manifest";
    else if (sha256(path) !== expected) {
      problem = "the sandbox helper does not match the package's manifest (changed or damaged)";
    } else if ((statSync(path).mode & 0o111) === 0) {
      problem = "the sandbox helper is not executable";
    }
  } catch {
    problem = "the package's sandbox manifest cannot be read";
  }
  verified.set(path, problem);
  return problem ? { problem } : { path, own: false };
}

/** The cgroup the person's session may manage (systemd delegates it), when it can be written. */
export function delegatedCgroup(uid = process.getuid?.() ?? -1): string | undefined {
  if (uid < 0) return undefined;
  const dir = `/sys/fs/cgroup/user.slice/user-${String(uid)}.slice/user@${String(uid)}.service`;
  try {
    accessSync(dir, constants.W_OK);
    const controllers = readFileSync(join(dir, "cgroup.subtree_control"), "utf8");
    return /\bmemory\b/.test(controllers) && /\bpids\b/.test(controllers) ? dir : undefined;
  } catch {
    return undefined;
  }
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(error.message, { cause: error }));
      else resolvePromise(stdout);
    });
  });
}

/** Linux: the helper, with namespaces, Landlock, seccomp and cgroups or resource limits. */
export class LinuxEngine implements IsolationEngine {
  readonly name = "linux" as const;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly root = packageRoot(),
  ) {}

  async probe(): Promise<EngineReport> {
    const helper = linuxHelper(this.env, this.root);
    if ("problem" in helper) {
      return {
        engine: "linux",
        available: false,
        reason: helper.problem,
        mechanisms: [],
        limitations: [],
      };
    }
    let found: { userns?: number; landlockAbi?: number; seccomp?: number };
    try {
      found = JSON.parse(await run(helper.path, ["--probe"])) as typeof found;
    } catch (error) {
      return {
        engine: "linux",
        available: false,
        reason: `the sandbox helper did not answer: ${error instanceof Error ? error.message : String(error)}`,
        mechanisms: [],
        limitations: [],
        helper: helper.path,
      };
    }
    const abi = found.landlockAbi ?? 0;
    const mechanisms = [
      ...(abi > 0 ? [`Landlock ABI ${String(abi)} (files${abi >= 4 ? ", TCP" : ""})`] : []),
      ...(found.userns ? ["user, PID, mount and network namespaces"] : []),
      ...(found.seccomp ? ["seccomp"] : []),
      ...(delegatedCgroup() ? ["cgroups v2 (delegated)"] : ["resource limits (rlimits)"]),
    ];
    const limitations = [
      ...(found.userns
        ? []
        : [
            "Unprivileged user namespaces are not allowed here (on Ubuntu 23.10 and later, AppArmor restricts them): no PID or network namespace, so the sandbox's processes can see the computer's process list, and without network only TCP is blocked (Landlock), not UDP or local sockets.",
          ]),
      ...(abi >= 4 || found.userns
        ? []
        : ["Without network namespaces nor Landlock ABI 4, a command's network cannot be closed."]),
      ...(delegatedCgroup()
        ? []
        : [
            "No delegated cgroup: memory is limited per process (address space), processes per user (counting the ones you run already).",
          ]),
      ...(helper.own
        ? [`A helper of your own is used (GRAFENO_SANDBOX_HELPER): ${helper.path}`]
        : []),
    ];
    if (abi <= 0) {
      return {
        engine: "linux",
        available: false,
        reason:
          "this kernel has no Landlock (5.13 or later, enabled in its security modules), so files cannot be closed off",
        mechanisms,
        limitations,
        helper: helper.path,
      };
    }
    return { engine: "linux", available: true, mechanisms, limitations, helper: helper.path };
  }

  wrap(argv: readonly [string, ...string[]], policy: SandboxPolicy, place: SandboxPlace): Wrapped {
    const helper = linuxHelper(this.env, this.root);
    if ("problem" in helper) throw new Error(helper.problem);
    const uid = process.getuid?.();
    const writable = [...policy.writable, place.home, place.tmp, "/dev"];
    const readable = [...SYSTEM_READ, ...programFolders(this.env), ...policy.readable];
    const underTmp = writable.some((p) => p === "/tmp" || p.startsWith("/tmp/"));
    const cgroup = delegatedCgroup();
    const args = [
      "--report-fd",
      "3",
      ...readable.flatMap((p) => ["--ro", p]),
      ...writable.flatMap((p) => ["--rw", p]),
      // The person's runtime folder holds sockets to their agents and sessions.
      ...(uid !== undefined && existsSync(`/run/user/${String(uid)}`)
        ? ["--hide", `/run/user/${String(uid)}`]
        : []),
      ...(underTmp ? [] : ["--private-tmp"]),
      ...(policy.network === "none" ? ["--no-network"] : []),
      "--memory",
      String(policy.limits.memoryMb * 1024 * 1024),
      "--cpu",
      String(policy.limits.cpuSeconds),
      "--procs",
      String(policy.limits.processes),
      "--files",
      String(policy.limits.files),
      ...(cgroup ? ["--cgroup", cgroup] : []),
      "--require",
      policy.network === "none" ? "fs,net" : "fs",
      "--",
      ...argv,
    ];
    return { file: helper.path, args, reportFd: 3 };
  }

  isolation(report: string | undefined, policy: SandboxPolicy): Isolation {
    let r: Record<string, unknown> = {};
    try {
      r = JSON.parse(report ?? "{}") as Record<string, unknown>;
    } catch {
      r = {};
    }
    const on = (k: string) => r[k] === 1 || r[k] === true;
    const network =
      r.network === "none" ? "none" : r.network === "tcp-blocked" ? "tcp-blocked" : "open";
    const mechanisms = [
      ...(on("landlockFs") ? [`Landlock ABI ${String(r.landlockAbi)}`] : []),
      ...(on("userns") ? ["user namespace"] : []),
      ...(on("pidns") ? ["PID namespace"] : []),
      ...(on("netns") ? ["network namespace"] : []),
      ...(on("mountns") ? ["mount namespace"] : []),
      ...(on("landlockNet") ? ["Landlock TCP"] : []),
      ...(on("seccomp") ? ["seccomp"] : []),
      ...(on("cgroup") ? ["cgroup"] : on("rlimits") ? ["rlimits"] : []),
    ];
    return {
      engine: "linux",
      files: on("landlockFs"),
      network: policy.network === "open" ? "open" : network,
      processes: on("pidns"),
      syscalls: on("seccomp"),
      limits: on("cgroup") || on("rlimits"),
      mechanisms,
    };
  }
}

/** A string in a sandbox profile, quoted as its language wants. */
function sbpl(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS: `sandbox-exec`, part of the system, with a profile written for the
 * command (Apple deprecates the command line, not the mechanism; it is what
 * macOS has without installing anything).
 */
export class MacEngine implements IsolationEngine {
  readonly name = "macos" as const;

  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  probe(): Promise<EngineReport> {
    const there = existsSync("/usr/bin/sandbox-exec");
    return Promise.resolve({
      engine: "macos",
      available: there,
      ...(there ? {} : { reason: "/usr/bin/sandbox-exec is not on this Mac" }),
      mechanisms: there ? ["sandbox-exec (files, network)", "resource limits (ulimit)"] : [],
      limitations: [
        "sandbox-exec is deprecated by Apple: it works, and may change in a later macOS.",
        "No PID isolation: the sandbox's processes can see the computer's process list.",
        "No memory limit (macOS does not enforce one per process); processes are limited per user.",
      ],
    });
  }

  profile(policy: SandboxPolicy, place: SandboxPlace): string {
    const home = homedir();
    const writable = [...policy.writable, place.home, place.tmp];
    const readable = [...programFolders(this.env), ...policy.readable, ...writable];
    return [
      "(version 1)",
      "(allow default)",
      // Nothing written outside what it may write.
      '(deny file-write* (subpath "/"))',
      `(allow file-write* ${writable.map((p) => `(subpath ${sbpl(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
      // Nothing read in the home folder but what it may read.
      `(deny file-read* (subpath ${sbpl(home)}))`,
      "(allow file-read-metadata)",
      `(allow file-read* ${readable.map((p) => `(subpath ${sbpl(p)})`).join(" ")})`,
      ...(policy.network === "none"
        ? [
            '(deny network-outbound (remote ip "*:*"))',
            '(allow network-outbound (remote ip "localhost:*"))',
          ]
        : []),
      "(deny process-info* (target others))",
    ].join("\n");
  }

  wrap(argv: readonly [string, ...string[]], policy: SandboxPolicy, place: SandboxPlace): Wrapped {
    const l = policy.limits;
    const limits = `ulimit -t ${String(l.cpuSeconds)}; ulimit -n ${String(l.files)}; exec "$@"`;
    return {
      file: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        this.profile(policy, place),
        "/bin/sh",
        "-c",
        limits,
        "grafeno-sandbox",
        ...argv,
      ],
    };
  }

  isolation(_report: string | undefined, policy: SandboxPolicy): Isolation {
    return {
      engine: "macos",
      files: true,
      network: policy.network === "none" ? "tcp-blocked" : "open",
      processes: false,
      syscalls: false,
      limits: true,
      mechanisms: ["sandbox-exec", "ulimit"],
    };
  }
}

/** A computer without an engine: commands are not isolated, and it is said. */
export class NoEngine implements IsolationEngine {
  readonly name = "none" as const;

  constructor(private readonly why: string) {}

  probe(): Promise<EngineReport> {
    return Promise.resolve({
      engine: "none",
      available: false,
      reason: this.why,
      mechanisms: [],
      limitations: [this.why],
    });
  }

  wrap(): Wrapped {
    throw new Error(this.why);
  }

  isolation(): Isolation {
    return {
      engine: "none",
      files: false,
      network: "open",
      processes: false,
      syscalls: false,
      limits: false,
      mechanisms: [],
    };
  }
}

/** The engine of this computer. */
export function detectEngine(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): IsolationEngine {
  if (platform === "linux") return new LinuxEngine(env);
  if (platform === "darwin") return new MacEngine(env);
  return new NoEngine(
    platform === "win32"
      ? "Windows has no isolation engine in Grafeno Sandbox yet (AppContainer and Job Objects are planned): commands run on this computer with your rights"
      : `${platform} has no isolation engine in Grafeno Sandbox`,
  );
}

/** What isolated a command, in a few words for its result (never more than was applied). */
export function describeIsolation(isolation: Isolation): string {
  if (isolation.engine === "none") return "not sandboxed";
  const parts = [
    isolation.files ? "files closed off" : "files NOT closed off",
    isolation.network === "none"
      ? "no network"
      : isolation.network === "tcp-blocked"
        ? "no TCP"
        : "network open",
    ...(isolation.processes ? ["own processes"] : []),
    ...(isolation.limits ? ["limits"] : []),
  ];
  return `sandboxed (${parts.join(", ")})`;
}
