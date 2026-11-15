import { spawn as nodeSpawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore, type OperationalStore, type Supervisor } from "./store.js";

/**
 * Phase D4 (brief §D.2): runs that go on without the terminal, decided
 * with the user as a detached process, with no service installed.
 *
 * - `run --background` starts a detached Grafeno Agent process that owns
 *   the run: it records its pid, beats its heart in the run store while it
 *   works, and takes orders (pause, cancel) sent through the store from any
 *   other terminal.
 * - After a reboot (or any death of that process), the run is still
 *   "running" in its store, with a heart that stopped: it is interrupted.
 *   The next start of `grafeno-agent` resumes it the same way, in its own
 *   project folder.
 * - When a background run ends or needs a person, a desktop notification
 *   says so (a Windows toast through PowerShell, notify-send on Linux,
 *   osascript on macOS), and its log is kept in the data folder.
 */

/** A heart silent for this long has stopped. */
export const STALE_MS = 60_000;

/** Whether a process lives (signal 0 checks without touching it). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it lives, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Liveness = "running" | "interrupted" | "stopped";

/**
 * Whether a run's owner works on it now (`running`), died while it was
 * running (`interrupted`: a reboot, a crash), or none runs it (`stopped`).
 */
export function liveness(
  store: OperationalStore,
  runId: string,
  now: Date = new Date(),
  alive: (pid: number) => boolean = isAlive,
): { liveness: Liveness; supervisor?: Supervisor } {
  const run = store.run(runId);
  const supervisor = store.supervisor(runId);
  const fresh =
    supervisor?.heartbeat !== undefined &&
    now.getTime() - Date.parse(supervisor.heartbeat) < STALE_MS;
  if (supervisor?.running === true && fresh && alive(supervisor.pid)) {
    return { liveness: "running", supervisor };
  }
  if (run?.state === "running") {
    return { liveness: "interrupted", ...(supervisor ? { supervisor } : {}) };
  }
  return { liveness: "stopped", ...(supervisor ? { supervisor } : {}) };
}

export interface InterruptedRun {
  readonly file: string;
  readonly runId: string;
  readonly supervisor: Supervisor;
}

/**
 * The background runs of every project that were interrupted: still
 * "running" in their store, with no live owner. Only runs started with
 * `--background` are resumed on their own; others wait for `resume`.
 */
export function interruptedRuns(
  dataDir: string,
  alive: (pid: number) => boolean = isAlive,
  now: Date = new Date(),
): InterruptedRun[] {
  const folder = join(dataDir, "runs");
  if (!existsSync(folder)) return [];
  const found: InterruptedRun[] = [];
  for (const name of readdirSync(folder).filter((f) => f.endsWith(".db"))) {
    const file = join(folder, name);
    const store = new SqliteStore(file);
    try {
      for (const run of store.runs()) {
        if (run.state !== "running") continue;
        const state = liveness(store, run.id, now, alive);
        if (state.liveness === "interrupted" && state.supervisor?.background === true) {
          found.push({ file, runId: run.id, supervisor: state.supervisor });
        }
      }
    } finally {
      store.close();
    }
  }
  return found;
}

/** How to start a detached Grafeno Agent: this program, with these arguments. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
}

/** This process's own command line: the node binary and the CLI it runs (tsx when from source). */
export function selfLaunch(): Launch {
  const entry = process.argv[1] ?? "";
  return { command: process.execPath, args: [...process.execArgv, entry] };
}

/**
 * Starts a detached Grafeno Agent that resumes a run in the background, its
 * output in a log file of the data folder. Returns the log's path and the
 * new process's pid.
 */
export function startBackground(
  runId: string,
  options: {
    readonly cwd: string;
    readonly dataDir: string;
    readonly args?: readonly string[];
    readonly launch?: Launch;
    readonly spawn?: typeof nodeSpawn;
  },
): { log: string; pid: number } {
  const logs = join(options.dataDir, "logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${runId}.log`);
  const out = openSync(log, "a");
  const launch = options.launch ?? selfLaunch();
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(
    launch.command,
    [...launch.args, "resume", runId, "--yes", "--owner=background", ...(options.args ?? [])],
    {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  return { log, pid: child.pid ?? 0 };
}

/** The command that shows a desktop notification on this system; undefined where there is none. */
export function notificationCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  if (platform === "win32") {
    // The text goes in environment variables, never into the script itself.
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$x = $t.GetElementsByTagName('text')",
      "$x.Item(0).AppendChild($t.CreateTextNode($env:GA_TITLE)) > $null",
      "$x.Item(1).AppendChild($t.CreateTextNode($env:GA_BODY)) > $null",
      "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      env: { GA_TITLE: title, GA_BODY: body },
    };
  }
  if (platform === "linux") return { command: "notify-send", args: [title, body] };
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
    };
  }
  return undefined;
}

/** Shows a desktop notification; a system without one, or a failure, is not an error. */
export function notify(title: string, body: string): Promise<void> {
  const how = notificationCommand(title, body);
  if (!how) return Promise.resolve();
  return new Promise((done) => {
    execFile(
      how.command,
      how.args,
      { windowsHide: true, timeout: 15_000, env: { ...process.env, ...how.env } },
      () => {
        done();
      },
    );
  });
}
