import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../../src/orchestrator/plan.js";
import {
  canTransition,
  TASK_STATES,
  TRANSITIONS,
  TransitionError,
  type TaskState,
} from "../../src/orchestrator/states.js";
import { SqliteStore } from "../../src/orchestrator/store.js";

const plan: Plan = {
  goal: "Build it",
  risks: [],
  tasks: ["contracts", "api", "ui"].map((id) => ({
    id,
    title: id,
    description: id,
    kind: "backend" as const,
    dependsOn: id === "contracts" ? [] : ["contracts"],
    complexity: 2,
    capabilities: ["code"],
    touches: [`src/${id}.ts`],
    acceptance: [{ check: "command" as const, run: "npm test" }],
    parallelSafe: true,
  })),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-store-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold the file a moment longer.
  }
});

describe("the task state machine", () => {
  it("allows exactly the transitions in its table", () => {
    const allowed: string[] = [];
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        if (canTransition(from, to)) allowed.push(`${from}>${to}`);
      }
    }
    expect(allowed.sort()).toEqual(
      Object.entries(TRANSITIONS)
        .flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))
        .sort(),
    );
    // A few that must never happen.
    expect(canTransition("completed", "ready")).toBe(false);
    expect(canTransition("pending", "running")).toBe(false);
    expect(canTransition("cancelled", "ready")).toBe(false);
    expect(canTransition("running", "pending")).toBe(false);
  });
});

describe("SqliteStore", () => {
  it("keeps runs and tasks across processes (reopening the file)", () => {
    const path = join(dir, "runs.db");
    const first = new SqliteStore(path);
    const run = first.createRun("Build it", plan, ["contracts", "api", "ui"], "abc123");
    first.transition(run.id, "contracts", "ready");
    first.transition(run.id, "contracts", "running", {
      attempts: 1,
      worker: "w1",
      model: "opus",
      effort: "high",
    });
    first.close();

    const second = new SqliteStore(path);
    expect(second.run(run.id)).toMatchObject({
      request: "Build it",
      state: "running",
      baseCommit: "abc123",
    });
    const tasks = second.tasks(run.id);
    expect(tasks.map((t) => [t.id, t.state])).toEqual([
      ["contracts", "running"],
      ["api", "pending"],
      ["ui", "pending"],
    ]);
    expect(tasks[0]).toMatchObject({ attempts: 1, worker: "w1", model: "opus", effort: "high" });
    second.close();
  });

  it("refuses a transition the table does not allow, and changes nothing", () => {
    const store = new SqliteStore();
    const run = store.createRun("x", plan, ["contracts", "api", "ui"]);
    const before = store.events(run.id).length;
    expect(() => store.transition(run.id, "api", "running")).toThrow(TransitionError);
    expect(store.task(run.id, "api")?.state).toBe("pending");
    expect(store.events(run.id).length).toBe(before);
    store.close();
  });

  it("walks a task through its life and records every step as an event", () => {
    const store = new SqliteStore();
    const run = store.createRun("x", plan, ["contracts", "api", "ui"]);
    const steps: TaskState[] = ["ready", "running", "ready", "running", "review", "completed"];
    for (const to of steps) store.transition(run.id, "contracts", to);
    const moves = store
      .events(run.id)
      .filter((e) => e.kind === "task_state")
      .map((e) => `${String(e.data.from)}>${String(e.data.to)}`);
    expect(moves).toEqual([
      "pending>ready",
      "ready>running",
      "running>ready",
      "ready>running",
      "running>review",
      "review>completed",
    ]);
    expect(() => store.transition(run.id, "contracts", "cancelled")).toThrow(TransitionError);
    store.close();
  });

  it("records irreversible effects once: a crash leaves them started, never run twice", () => {
    const store = new SqliteStore();
    const run = store.createRun("x", plan, ["contracts", "api", "ui"]);
    expect(store.beginEffect("merge:api", run.id, "merge")).toBe("new");
    // The process dies here; on restart the same effect is seen as started.
    expect(store.beginEffect("merge:api", run.id, "merge")).toBe("started");
    store.finishEffect("merge:api");
    expect(store.beginEffect("merge:api", run.id, "merge")).toBe("done");
    store.close();
  });

  it("lists runs and pauses one", () => {
    const store = new SqliteStore();
    const a = store.createRun("first", plan, ["contracts", "api", "ui"]);
    store.setRunState(a.id, "paused");
    expect(store.runs().map((r) => r.state)).toEqual(["paused"]);
    expect(
      store.events(a.id).some((e) => e.kind === "run_state" && e.data.state === "paused"),
    ).toBe(true);
    store.close();
  });
});
