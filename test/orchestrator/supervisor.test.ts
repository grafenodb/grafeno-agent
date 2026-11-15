import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import {
  interruptedRuns,
  isAlive,
  liveness,
  notificationCommand,
  STALE_MS,
  startBackground,
} from "../../src/orchestrator/supervisor.js";
import type { Provider } from "../../src/providers/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-supervisor-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a folder a moment longer.
  }
});

function spec(id: string): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${id}.txt.`,
    kind: "backend",
    dependsOn: [],
    complexity: 1,
    capabilities: ["code"],
    touches: [`${id}.txt`],
    acceptance: [{ check: "files", exist: [`${id}.txt`] }],
    parallelSafe: true,
  };
}

const plan = (ids: string[]): Plan => ({ goal: "g", risks: [], tasks: ids.map(spec) });

describe("the store as the way between processes", () => {
  it("keeps who runs a run, its heart, and an order taken once", () => {
    const store = new SqliteStore(join(dir, "p.db"));
    const run = store.createRun("r", plan(["a"]), ["a"]);
    store.supervise(run.id, {
      pid: 4242,
      background: true,
      cwd: "/work/p",
      args: ["--mode", "extended"],
    });
    expect(store.supervisor(run.id)).toMatchObject({
      pid: 4242,
      running: true,
      background: true,
      cwd: "/work/p",
      args: ["--mode", "extended"],
    });
    // Another process (another connection to the same file) sends an order.
    const other = new SqliteStore(join(dir, "p.db"));
    other.requestControl(run.id, "pause");
    other.close();
    expect(store.takeControl(run.id)).toBe("pause");
    expect(store.takeControl(run.id)).toBeUndefined();
    store.unsupervise(run.id);
    expect(store.supervisor(run.id)).toMatchObject({ running: false, cwd: "/work/p" });
    store.close();
  });
});

describe("liveness", () => {
  it("tells a live owner from an interrupted run and a stopped one", () => {
    const store = new SqliteStore();
    const run = store.createRun("r", plan(["a"]), ["a"]);
    const now = new Date();
    expect(liveness(store, run.id, now).liveness).toBe("interrupted"); // running, no owner
    store.supervise(run.id, { pid: 7, background: false });
    expect(liveness(store, run.id, now, () => true).liveness).toBe("running");
    expect(liveness(store, run.id, now, () => false).liveness).toBe("interrupted"); // its process died
    const later = new Date(now.getTime() + STALE_MS + 1000);
    expect(liveness(store, run.id, later, () => true).liveness).toBe("interrupted"); // its heart stopped
    store.setRunState(run.id, "paused");
    store.unsupervise(run.id);
    expect(liveness(store, run.id, now).liveness).toBe("stopped");
  });

  it("knows this process lives, and a pid that cannot be one does not", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-5)).toBe(false);
  });
});

describe("interruptedRuns", () => {
  it("finds the background runs of every project left running with no live owner", () => {
    mkdirSync(join(dir, "runs"));
    const shop = new SqliteStore(join(dir, "runs", "shop.db"));
    const background = shop.createRun("bg", plan(["a"]), ["a"]);
    shop.supervise(background.id, { pid: 99999, background: true, cwd: "/work/shop" });
    const foreground = shop.createRun("fg", plan(["a"]), ["a"]);
    shop.supervise(foreground.id, { pid: 99998, background: false });
    const live = shop.createRun("live", plan(["a"]), ["a"]);
    shop.supervise(live.id, { pid: process.pid, background: true });
    shop.close();
    const found = interruptedRuns(dir, (pid) => pid === process.pid);
    expect(found.map((r) => [r.runId, r.supervisor.cwd])).toEqual([[background.id, "/work/shop"]]);
    expect(interruptedRuns(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("startBackground", () => {
  it("starts a detached Grafeno Agent that resumes the run, logging to the data folder", () => {
    const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] =
      [];
    const fakeSpawn = ((
      command: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      return { pid: 31337, unref: () => undefined };
    }) as unknown as typeof import("node:child_process").spawn;
    const started = startBackground("run-1", {
      cwd: "/work/shop",
      dataDir: dir,
      args: ["--mode", "extended"],
      launch: { command: "node", args: ["cli.js"] },
      spawn: fakeSpawn,
    });
    expect(started).toEqual({ log: join(dir, "logs", "run-1.log"), pid: 31337 });
    expect(calls[0]?.command).toBe("node");
    expect(calls[0]?.args).toEqual([
      "cli.js",
      "resume",
      "run-1",
      "--yes",
      "--owner=background",
      "--mode",
      "extended",
    ]);
    expect(calls[0]?.options).toMatchObject({
      cwd: "/work/shop",
      detached: true,
      windowsHide: true,
    });
  });
});

describe("notifications", () => {
  it("uses each system's own way, with the text kept out of the script", () => {
    const win = notificationCommand("Grafeno Agent", "Run x: done; $(rm -rf /)", "win32");
    expect(win?.command).toBe("powershell.exe");
    expect(win?.args.join(" ")).not.toContain("rm -rf");
    expect(win?.env).toEqual({ GA_TITLE: "Grafeno Agent", GA_BODY: "Run x: done; $(rm -rf /)" });
    expect(notificationCommand("T", "B", "linux")).toEqual({
      command: "notify-send",
      args: ["T", "B"],
    });
    expect(notificationCommand("T", "B", "darwin")?.command).toBe("osascript");
    expect(notificationCommand("T", "B", "aix")).toBeUndefined();
  });
});

describe("an orchestrator owning a run", { timeout: 60_000 }, () => {
  function provider(): Provider {
    const turn: FakeTurn = (c) => {
      const file = /these files exist: (\S+)/.exec(c.message)?.[1] ?? "x.txt";
      return [
        { wait: 400 },
        { call: "write_file", input: { path: file, content: "ok\n" } },
        { say: "Done." },
      ];
    };
    return {
      id: "fake",
      name: "Fake",
      signIn: "",
      tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () => Promise.resolve([{ id: "m", name: "M" }]),
      efforts: () => ["low"],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: () => new FakeModel({ turns: [turn] }),
    };
  }

  function orchestratorWithRun(name: string) {
    const project = join(dir, name);
    mkdirSync(project);
    const orchestrator = new Orchestrator({
      provider: provider(),
      project: { name, path: project },
      projectRoot: project,
      dataDir: join(dir, "data"),
      maxWorkers: 1,
      metrics: false,
      owner: { heartbeatMs: 50 },
    });
    const run = orchestrator.store.createRun("three", plan(["a", "b", "c"]), ["a", "b", "c"]);
    return { orchestrator, run, file: join(dir, "data", "runs", `${name}.db`) };
  }

  it("obeys a pause sent from another process: what runs finishes, nothing new starts", async () => {
    const { orchestrator, run, file } = orchestratorWithRun("paused");
    const running = orchestrator.run(run.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const other = new SqliteStore(file);
    expect(liveness(other, run.id).liveness).toBe("running");
    other.requestControl(run.id, "pause");
    other.close();
    expect(await running).toBe("paused");
    expect(orchestrator.store.task(run.id, "a")?.state).toBe("completed");
    expect(orchestrator.store.task(run.id, "c")?.state).not.toBe("completed");
    expect(orchestrator.store.supervisor(run.id)?.running).toBe(false);
    orchestrator.close();
  });

  it("obeys a cancel sent from another process", async () => {
    const { orchestrator, run, file } = orchestratorWithRun("cancelled");
    const running = orchestrator.run(run.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const other = new SqliteStore(file);
    other.requestControl(run.id, "cancel");
    other.close();
    expect(await running).toBe("cancelled");
    orchestrator.close();
  });
});
