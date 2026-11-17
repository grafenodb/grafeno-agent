import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { dataDir } from "../data-dir.js";
import {
  describeIsolation,
  detectEngine,
  type EngineReport,
  type IsolationEngine,
  type Isolation,
  type SandboxPolicy,
} from "./engines.js";
import {
  PROFILES,
  keepPolicy,
  networkFor,
  networkSetting,
  profileFor,
  sandboxEnv,
  sandboxMode,
  type KeepPolicy,
  type NetworkPolicy,
  type ProfileName,
  type SandboxMode,
} from "./policy.js";

/** A sandbox: its own home and temporary folder, the work folder it may write, its state. */
export interface SandboxRecord {
  readonly id: string;
  /** What it is for: "chat", a task's id… */
  readonly label: string;
  readonly created: string;
  /** The work folder (the project, or a task's worktree) it may write. */
  readonly workspace: string;
  /** Other folders it may write (a worktree's repository). */
  readonly writable: readonly string[];
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
  readonly keep: KeepPolicy;
  /** Stopped: its processes were ended; it takes no more commands until it is used again. */
  readonly stopped?: boolean;
  /** The agent's process that made it: when it is gone, a sandbox it would have removed is stale. */
  readonly owner?: number;
  /** Removing what the system kept for it (Windows' permissions and profile) failed: tried again later. */
  readonly cleanupFailed?: boolean;
}

/** A sandbox as the commands see it now: its record, and whether something runs in it. */
export interface SandboxState extends SandboxRecord {
  readonly running: number;
  readonly size?: number;
}

/** A command started by the sandbox: the process, and what isolated it once the engine says. */
export interface Started {
  readonly child: ChildProcess;
  /** What was applied, from the engine's report (resolved before the command's output ends). */
  readonly isolation: Promise<Isolation>;
}

/**
 * How the agent's tools start commands, sandboxed or not: one interface for
 * every provider, so whoever asks for a command, it runs the same way.
 */
export interface Spawner {
  start(
    argv: readonly [string, ...string[]],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string | undefined>;
      /** The command line, to decide its network and profile (never stored). */
      readonly command: string;
    },
  ): Promise<Started>;
}

/** Starts commands on the computer, as before: said as such. */
export const HOST_SPAWNER: Spawner = {
  start(argv, options) {
    const [file, ...args] = argv;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    return Promise.resolve({
      child,
      isolation: Promise.resolve({
        engine: "none",
        files: false,
        network: "open",
        processes: false,
        syscalls: false,
        limits: false,
        mechanisms: [],
      }),
    });
  },
};

export interface SandboxManagerOptions {
  /** Where sandboxes are kept. Default: `sandboxes` in the agent's data folder. */
  readonly dir?: string;
  readonly engine?: IsolationEngine;
  readonly env?: Record<string, string | undefined>;
}

/** A security event: what happened, never a command's text, output or secrets. */
interface SecurityEvent {
  readonly at: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

/**
 * Grafeno Sandbox's manager: makes, runs, stops and destroys sandboxes, in
 * this process (no daemon), kept as folders in the agent's data folder. Each
 * command runs through the engine of this computer, which reports what it
 * applied; where there is no engine, commands run on the computer only in
 * `auto`, and every result says so.
 */
export class SandboxManager {
  readonly dir: string;
  readonly engine: IsolationEngine;
  readonly #env: Record<string, string | undefined>;
  readonly #running = new Map<string, Set<ChildProcess>>();
  #report: Promise<EngineReport> | undefined;
  #swept = false;

  constructor(options: SandboxManagerOptions = {}) {
    this.#env = options.env ?? process.env;
    this.dir = options.dir ?? join(dataDir(this.#env), "sandboxes");
    this.engine = options.engine ?? detectEngine(this.#env);
  }

  get mode(): SandboxMode {
    return sandboxMode(this.#env);
  }

  /** What this computer's engine can do, asked once. */
  report(fresh = false): Promise<EngineReport> {
    if (fresh || !this.#report) this.#report = this.engine.probe();
    return this.#report;
  }

  /** Makes a sandbox for a work folder: its own home and temporary folder, nothing of the person's. */
  create(options: {
    readonly label: string;
    readonly workspace: string;
    readonly writable?: readonly string[];
    readonly keep?: KeepPolicy;
  }): SandboxRecord {
    if (!this.#swept) {
      this.#swept = true;
      this.sweep();
    }
    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const dir = join(this.dir, id);
    const record: SandboxRecord = {
      id,
      label: options.label,
      created: new Date().toISOString(),
      workspace: options.workspace,
      writable: options.writable ?? [],
      dir,
      home: join(dir, "home"),
      tmp: join(dir, "tmp"),
      keep: options.keep ?? keepPolicy(this.#env),
      owner: process.pid,
    };
    mkdirSync(record.home, { recursive: true, mode: 0o700 });
    mkdirSync(record.tmp, { recursive: true, mode: 0o700 });
    // Who commits, never how to sign in: only the name and e-mail of the person's git.
    writeFileSync(join(record.home, ".gitconfig"), gitIdentity(), { mode: 0o600 });
    this.#save(record);
    this.#event(record, { event: "created", label: record.label });
    return record;
  }

  #save(record: SandboxRecord): void {
    writeFileSync(join(record.dir, "sandbox.json"), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  #event(record: Pick<SandboxRecord, "dir">, event: Omit<SecurityEvent, "at">): void {
    try {
      appendFileSync(
        join(record.dir, "events.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // A sandbox destroyed meanwhile has no log.
    }
  }

  /** The sandboxes kept, newest first, with what runs in each now. */
  list(): SandboxState[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((name) => this.get(name))
      .filter((s): s is SandboxState => s !== undefined)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  get(id: string): SandboxState | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    const file = join(this.dir, id, "sandbox.json");
    if (!existsSync(file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as SandboxRecord;
      return { ...record, running: this.#running.get(id)?.size ?? 0 };
    } catch {
      return undefined;
    }
  }

  /** A sandbox in detail: its record, its size and its last security events. */
  inspect(id: string): { state: SandboxState; size: number; events: string[] } | undefined {
    const state = this.get(id);
    if (!state) return undefined;
    let events: string[];
    try {
      events = readFileSync(join(state.dir, "events.jsonl"), "utf8").trim().split("\n").slice(-20);
    } catch {
      events = [];
    }
    return { state, size: sizeOf(state.dir), events };
  }

  /** Ends everything running in a sandbox; it stays, and may run commands again. */
  stop(id: string): boolean {
    const state = this.get(id);
    if (!state) return false;
    for (const child of this.#running.get(id) ?? []) killGroup(child);
    this.#running.delete(id);
    this.#save({ ...without(state), stopped: true });
    this.#event(state, { event: "stopped" });
    return true;
  }

  /** Ends everything in a sandbox and removes it, its home and temporary folder with it. */
  destroy(id: string): boolean {
    const state = this.get(id);
    if (!state) return false;
    for (const child of this.#running.get(id) ?? []) killGroup(child);
    this.#running.delete(id);
    const { policy } = this.policy(state, "");
    // What the system kept for it first; its folder stays when that fails, to try again.
    if (this.engine.cleanup && !this.engine.cleanup(policy, state)) {
      this.#save({ ...without(state), stopped: true, cleanupFailed: true });
      this.#event(state, { event: "cleanup-failed" });
      return false;
    }
    rmSync(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  }

  /**
   * Removes the sandboxes left by an agent that ended without removing them
   * (killed, crashed): not kept on purpose, nothing running, their maker
   * gone. With them goes what the system kept for them (Windows'
   * permissions on the project's folders). Says how many.
   */
  sweep(): number {
    let removed = 0;
    for (const s of this.list()) {
      if (s.running > 0) continue;
      const stale =
        s.cleanupFailed === true ||
        (s.keep === "never" && s.owner !== undefined && s.owner !== process.pid && !alive(s.owner));
      if (stale && this.destroy(s.id)) removed++;
    }
    return removed;
  }

  /** What a sandbox is done for: destroyed, or kept as its policy says. */
  finish(id: string, failed: boolean): void {
    const state = this.get(id);
    if (!state) return;
    const keep = state.keep === "always" || (state.keep === "failed" && failed);
    if (keep) {
      this.stop(id);
      this.#event(state, { event: "kept", failed });
    } else this.destroy(id);
  }

  /** Removes the sandboxes where nothing runs (older than `olderThanMs`, when given); says how many. */
  cleanup(olderThanMs = 0): number {
    let removed = this.sweep();
    for (const s of this.list()) {
      if (s.running > 0) continue;
      if (olderThanMs > 0 && Date.now() - Date.parse(s.created) < olderThanMs) continue;
      if (this.destroy(s.id)) removed++;
    }
    return removed;
  }

  /** The policy of one command in a sandbox: what it may touch, its network and limits. */
  policy(
    record: SandboxRecord,
    command: string,
  ): {
    policy: SandboxPolicy;
    profile: ProfileName;
    network: NetworkPolicy;
  } {
    const network = networkFor(command, networkSetting(this.#env));
    const profile = profileFor(command, network);
    return {
      policy: {
        writable: [record.workspace, ...record.writable],
        readable: [],
        network,
        limits: PROFILES[profile],
      },
      profile,
      network,
    };
  }

  /**
   * Starts a command in a sandbox. Without an engine: refused in
   * `required`; on the computer in `auto` (its isolation says "none", and
   * the tool's result says so).
   */
  async start(
    record: SandboxRecord,
    argv: readonly [string, ...string[]],
    options: { cwd: string; env: Record<string, string | undefined>; command: string },
  ): Promise<Started> {
    const report = await this.report();
    const { policy, profile, network } = this.policy(record, options.command);
    const env = sandboxEnv(options.env, record, join);
    if (!report.available) {
      if (this.mode === "required") {
        this.#event(record, { event: "refused", reason: report.reason ?? "no engine" });
        throw new Error(
          `the sandbox is required (AGENT_SANDBOX=required) and this computer has none: ${report.reason ?? "no engine"}`,
        );
      }
      this.#event(record, {
        event: "unsandboxed",
        program: basename(argv[0]),
        reason: report.reason,
      });
      return HOST_SPAWNER.start(argv, { ...options, env });
    }
    const wrapped = this.engine.wrap(argv, policy, record);
    const child = spawn(wrapped.file, [...wrapped.args], {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio:
        wrapped.reportFd === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
    });
    const set = this.#running.get(record.id) ?? new Set<ChildProcess>();
    set.add(child);
    this.#running.set(record.id, set);
    const started = (line: string | undefined): Isolation => {
      const isolationNow = this.engine.isolation(line, policy);
      if (line?.includes('"error"')) {
        this.#event(record, {
          event: "failed",
          program: basename(argv[0]),
          report: safeReport(line),
        });
      } else {
        this.#event(record, {
          event: "started",
          program: basename(argv[0]),
          profile,
          network,
          isolation: describeIsolation(isolationNow),
          mechanisms: isolationNow.mechanisms,
        });
      }
      return isolationNow;
    };
    const isolation = new Promise<Isolation>((resolvePromise) => {
      const stream = wrapped.reportFd === undefined ? undefined : child.stdio[wrapped.reportFd];
      if (!stream || !("on" in stream)) {
        resolvePromise(started(undefined));
        return;
      }
      let text = "";
      stream.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      stream.on("close", () => {
        resolvePromise(started(text.trim().split("\n")[0]));
      });
    });
    child.on("exit", (code, signal) => {
      set.delete(child);
      this.#event(record, {
        event: "ended",
        program: basename(argv[0]),
        ...(code === null ? { signal } : { code }),
        // 125: the sandbox could not be made as required.
        ...(code === 125 ? { sandbox: "not made as required" } : {}),
      });
    });
    return { child, isolation };
  }

  /** A spawner for one sandbox, made when the first command needs it. */
  spawner(
    make: () => SandboxRecord,
  ): Spawner & { readonly record: () => SandboxRecord | undefined } {
    let record: SandboxRecord | undefined;
    return {
      record: () => record,
      start: (argv, options) => {
        record ??= make();
        return this.start(record, argv, options);
      },
    };
  }
}

function without(state: SandboxState): SandboxRecord {
  const record: Record<string, unknown> = { ...state };
  delete record.running;
  delete record.size;
  return record as unknown as SandboxRecord;
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there, someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ends a command and everything it started: its process group. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function sizeOf(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += sizeOf(path);
      else if (entry.isFile()) total += statSync(path).size;
    }
  } catch {
    // Gone meanwhile.
  }
  return total;
}

/** The engine's report, as is: it holds only mechanism names and numbers. */
function safeReport(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return "unreadable";
  }
}

/** The person's git name and e-mail, for commits in a sandbox; nothing else of their settings. */
function gitIdentity(): string {
  const read = (key: string) => {
    try {
      return execFileSync("git", ["config", "--global", key], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name && !email) return "";
  const quote = (v: string) => v.replace(/[\\"]/g, (c) => `\\${c}`);
  return `[user]\n${name ? `\tname = "${quote(name)}"\n` : ""}${email ? `\temail = "${quote(email)}"\n` : ""}`;
}

let shared: SandboxManager | undefined;

/** The process's sandbox manager: one, so every session and run share its list and its engine. */
export function sandboxManager(): SandboxManager {
  shared ??= new SandboxManager();
  return shared;
}

/** A spawner as an option of the tools, when there is one. */
export function withSpawner(spawner: Spawner | undefined): { spawner?: Spawner } {
  return spawner ? { spawner } : {};
}
