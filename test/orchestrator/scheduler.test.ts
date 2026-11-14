import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import {
  Scheduler,
  touchesOverlap,
  type AttemptContext,
  type AttemptOutcome,
  type TaskRunner,
} from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import type { TaskRecord } from "../../src/orchestrator/store.js";

function spec(id: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    description: id,
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: [`src/${id}.ts`],
    acceptance: [{ check: "command", run: "npm test" }],
    parallelSafe: true,
    ...extra,
  };
}

function makePlan(tasks: TaskSpec[]): { plan: Plan; order: string[] } {
  return { plan: { goal: "test", risks: [], tasks }, order: tasks.map((t) => t.id) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Behaviour = (task: TaskRecord, context: AttemptContext) => Promise<AttemptOutcome>;

/** A runner that does what each task's script says, and watches how many run at once. */
class ScriptedRunner implements TaskRunner {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  running = 0;
  most = 0;

  constructor(
    private readonly scripts: Record<string, Behaviour> = {},
    private readonly fallback: Behaviour = async () => {
      await sleep(25);
      return { status: "completed" };
    },
  ) {}

  async run(task: TaskRecord, context: AttemptContext): Promise<AttemptOutcome> {
    this.started.push(task.id);
    this.running++;
    this.most = Math.max(this.most, this.running);
    try {
      return await (this.scripts[task.id] ?? this.fallback)(task, context);
    } finally {
      this.running--;
      this.finished.push(task.id);
    }
  }
}

/** Waits until the signal aborts. */
function untilAborted(signal: AbortSignal): Promise<AttemptOutcome> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      resolve({ status: "retry", reason: "aborted" });
    });
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-sched-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold the database a moment longer.
  }
});

function setup(tasks: TaskSpec[]) {
  const store = new SqliteStore();
  const { plan, order } = makePlan(tasks);
  const run = store.createRun("test", plan, order);
  const state = (id: string) => store.task(run.id, id)?.state;
  return { store, run, state };
}

describe("the scheduler: order and parallelism", () => {
  it("runs what is ready in parallel, after its dependencies, up to the limit", async () => {
    const { store, run, state } = setup([
      spec("contracts", { kind: "architecture" }),
      spec("api", { dependsOn: ["contracts"] }),
      spec("ui", { kind: "frontend", dependsOn: ["contracts"] }),
      spec("docs", { kind: "docs", dependsOn: ["contracts"] }),
      spec("tests", { kind: "tests", dependsOn: ["api", "ui", "docs"] }),
    ]);
    const runner = new ScriptedRunner();
    const result = await new Scheduler({ store, runner, maxWorkers: 3 }).run(run.id);
    expect(result).toBe("completed");
    expect(runner.most).toBe(3);
    expect(runner.started[0]).toBe("contracts");
    expect(runner.started.slice(1, 4).sort()).toEqual(["api", "docs", "ui"]);
    expect(runner.started[4]).toBe("tests");
    expect(runner.finished.indexOf("contracts")).toBe(0);
    expect(state("tests")).toBe("completed");
  });

  it("keeps to the number of workers allowed", async () => {
    const { store, run } = setup(["a", "b", "c", "d", "e"].map((id) => spec(id)));
    const runner = new ScriptedRunner();
    await new Scheduler({ store, runner, maxWorkers: 2 }).run(run.id);
    expect(runner.most).toBe(2);
    expect(runner.started.length).toBe(5);
  });

  it("never runs two tasks that touch the same files at once", async () => {
    const { store, run } = setup([
      spec("folder", { touches: ["src/api/"] }),
      spec("file", { touches: ["src/api/users.ts"] }),
      spec("other", { touches: ["src/ui/app.tsx"] }),
    ]);
    const together: string[][] = [];
    const runner = new ScriptedRunner({}, async () => {
      together.push([...scheduler.running]);
      await sleep(25);
      return { status: "completed" };
    });
    const scheduler = new Scheduler({ store, runner, maxWorkers: 3 });
    await scheduler.run(run.id);
    expect(together.some((ids) => ids.includes("folder") && ids.includes("file"))).toBe(false);
    expect(runner.most).toBe(2);
  });

  it("runs a task that is not safe in parallel on its own", async () => {
    const { store, run } = setup([spec("a"), spec("alone", { parallelSafe: false }), spec("b")]);
    const runner = new ScriptedRunner();
    const scheduler = new Scheduler({ store, runner, maxWorkers: 3 });
    const seenWithAlone: string[][] = [];
    const watching = new ScriptedRunner({
      alone: async () => {
        seenWithAlone.push([...scheduler.running]);
        await sleep(25);
        return { status: "completed" };
      },
    });
    Object.assign(runner, { run: watching.run.bind(watching) });
    await scheduler.run(run.id);
    expect(seenWithAlone).toEqual([["alone"]]);
  });
});

describe("the scheduler: failures", () => {
  it("retries what may work another time, up to the limit", async () => {
    const { store, run, state } = setup([spec("flaky")]);
    let tries = 0;
    const runner = new ScriptedRunner({
      flaky: () => {
        tries++;
        return Promise.resolve(
          tries < 3 ? { status: "retry", reason: "network" } : { status: "completed" },
        );
      },
    });
    expect(await new Scheduler({ store, runner, maxAttempts: 3 }).run(run.id)).toBe("completed");
    expect(store.task(run.id, "flaky")?.attempts).toBe(3);
    expect(state("flaky")).toBe("completed");
  });

  it("fails a task out of attempts, blocks what depends on it, and fails the run", async () => {
    const { store, run, state } = setup([
      spec("base"),
      spec("needs-base", { dependsOn: ["base"] }),
      spec("needs-that", { dependsOn: ["needs-base"] }),
      spec("independent"),
    ]);
    const runner = new ScriptedRunner({
      base: () => {
        throw new Error("crashed");
      },
    });
    expect(await new Scheduler({ store, runner, maxAttempts: 2 }).run(run.id)).toBe("failed");
    expect(state("base")).toBe("failed");
    expect(store.task(run.id, "base")?.reason).toContain("crashed (after 2 attempts)");
    expect(state("needs-base")).toBe("blocked");
    expect(state("needs-that")).toBe("blocked");
    expect(state("independent")).toBe("completed");
    expect(runner.started.filter((id) => id === "needs-base")).toEqual([]);
  });

  it("stops an attempt at its timeout, even when the runner ignores the signal", async () => {
    const { store, run, state } = setup([spec("polite"), spec("deaf")]);
    const runner = new ScriptedRunner({
      polite: (_task, context) => untilAborted(context.signal),
      deaf: () => new Promise<AttemptOutcome>(() => undefined),
    });
    const result = await new Scheduler({ store, runner, maxAttempts: 1, attemptTimeoutMs: 60 }).run(
      run.id,
    );
    expect(result).toBe("failed");
    expect(state("polite")).toBe("failed");
    expect(store.task(run.id, "deaf")?.reason).toMatch(/timed out/);
  });

  it("waits for a person when a task needs review", async () => {
    const { store, run, state } = setup([spec("merge"), spec("after", { dependsOn: ["merge"] })]);
    const runner = new ScriptedRunner({
      merge: () => Promise.resolve({ status: "review", reason: "conflict in src/a.ts" }),
    });
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("waiting");
    expect(state("merge")).toBe("review");
    expect(state("after")).toBe("pending");
  });
});

describe("the scheduler: control", () => {
  it("cancels what runs and what waits", async () => {
    const { store, run, state } = setup([spec("slow"), spec("later", { dependsOn: ["slow"] })]);
    let sawAbort = false;
    const runner = new ScriptedRunner({
      slow: async (_task, context) => {
        const outcome = await untilAborted(context.signal);
        sawAbort = true;
        return outcome;
      },
    });
    const scheduler = new Scheduler({ store, runner });
    const result = scheduler.run(run.id);
    await sleep(30);
    scheduler.cancel();
    expect(await result).toBe("cancelled");
    expect(sawAbort).toBe(true);
    expect(state("slow")).toBe("cancelled");
    expect(state("later")).toBe("cancelled");
  });

  it("pauses (what runs finishes, nothing new starts) and resumes", async () => {
    const { store, run, state } = setup([spec("first"), spec("second", { dependsOn: ["first"] })]);
    const runner = new ScriptedRunner();
    const scheduler = new Scheduler({ store, runner });
    const result = scheduler.run(run.id);
    await sleep(5);
    scheduler.pause();
    expect(await result).toBe("paused");
    expect(state("first")).toBe("completed");
    expect(state("second")).not.toBe("running");
    expect(runner.started).toEqual(["first"]);
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("completed");
    expect(state("second")).toBe("completed");
  });

  it("pauses the run when the provider's limit is reached, without spending the task's attempt", async () => {
    const { store, run, state } = setup([spec("big"), spec("next", { dependsOn: ["big"] })]);
    const resetsAt = new Date("2026-11-14T23:00:00Z");
    let calls = 0;
    const runner = new ScriptedRunner({
      big: () => {
        calls++;
        return Promise.resolve(
          calls === 1
            ? { status: "quota", reason: "usage limit", resetsAt }
            : { status: "completed" },
        );
      },
    });
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("paused");
    expect(state("big")).toBe("ready");
    expect(store.task(run.id, "big")?.attempts).toBe(0);
    const reasons = store.events(run.id).filter((e) => e.kind === "run_reason");
    expect(String(reasons.at(-1)?.data.reason)).toContain("2026-11-14T23:00:00.000Z");
    // After the reset, the same run goes on.
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("completed");
  });

  it("resumes after the process died, checking an effect instead of doing it twice", async () => {
    const path = join(dir, "runs.db");
    const before = new SqliteStore(path);
    const { plan, order } = makePlan([spec("merge"), spec("after", { dependsOn: ["merge"] })]);
    const run = before.createRun("test", plan, order);
    // What a process leaves when it dies in the middle of a merge:
    before.transition(run.id, "merge", "ready");
    before.transition(run.id, "merge", "running", { attempts: 1 });
    expect(before.beginEffect(`merge:${run.id}:merge`, run.id, "merge")).toBe("new");
    before.close();

    const store = new SqliteStore(path);
    let merges = 0;
    const runner = new ScriptedRunner({
      merge: (task, context) => {
        const key = `merge:${context.runId}:${task.id}`;
        const status = store.beginEffect(key, context.runId, "merge");
        if (status === "new") merges++;
        // "started": check the world (is the merge there?) — here it is — and finish.
        store.finishEffect(key);
        return Promise.resolve({ status: "completed" });
      },
    });
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("completed");
    expect(merges).toBe(0);
    expect(store.task(run.id, "merge")?.attempts).toBe(2);
    const interrupted = store
      .events(run.id)
      .find((e) => e.kind === "attempt_ended" && String(e.data.reason).includes("interrupted"));
    expect(interrupted).toBeDefined();
    store.close();
  });
});

describe("touchesOverlap", () => {
  it("sees files under folders, globs by their fixed part, and nothing in empty lists", () => {
    expect(touchesOverlap(["src/api/"], ["src/api/users.ts"])).toBe(true);
    expect(touchesOverlap(["src/api/*.ts"], ["src/api/users.ts"])).toBe(true);
    expect(touchesOverlap(["./src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(touchesOverlap(["src/api"], ["src/apiary/x.ts"])).toBe(false);
    expect(touchesOverlap(["src/a.ts"], ["docs/a.md"])).toBe(false);
    expect(touchesOverlap([], ["src/a.ts"])).toBe(false);
    expect(touchesOverlap(["*"], ["anything.ts"])).toBe(true);
  });
});
