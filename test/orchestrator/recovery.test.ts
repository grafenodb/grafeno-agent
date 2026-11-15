import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { Scheduler } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";

/**
 * Phase D3: recovery, one failure of the brief's list at a time. The
 * failures not here are shown elsewhere (see docs/orchestration.md, D1):
 * a timeout and a process that died (scheduler.test.ts), a plan's limit
 * (scheduler and workers tests), a provider set aside for another
 * (providers.test.ts), a git conflict (worktrees.test.ts) and failed
 * checks (verify.test.ts).
 */

function spec(id: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}.`,
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

/** A provider whose each model (one per attempt) plays the next script. */
function provider(scripts: FakeTurn[][]): { provider: Provider; created: number } {
  const state = { provider: undefined as unknown as Provider, created: 0 };
  state.provider = {
    id: "fake",
    name: "Fake",
    signIn: "",
    tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () => Promise.resolve([{ id: "m", name: "M" }]),
    efforts: () => ["low"],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: () => {
      const turns = scripts[state.created] ?? scripts.at(-1) ?? [];
      state.created++;
      return new FakeModel({ turns });
    },
  };
  return state;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-recovery-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a folder a moment longer.
  }
});

function setup(tasks: TaskSpec[]) {
  const store = new SqliteStore();
  const plan: Plan = { goal: "g", risks: [], tasks };
  return {
    store,
    run: store.createRun(
      "r",
      plan,
      tasks.map((t) => t.id),
    ),
  };
}

const ownFolder = (task: { id: string }) => {
  const folder = join(dir, task.id);
  mkdirSync(folder, { recursive: true });
  return Promise.resolve(new Workspace(folder));
};

describe("recovery (phase D3)", () => {
  it("a worker that crashes mid-task is retried, and the task completes on the next attempt", async () => {
    const { store, run } = setup([spec("api")]);
    const fake = provider([
      [[{ fail: "unavailable", message: "Claude Code exited unexpectedly" }]],
      [[{ say: "Done." }]],
    ]);
    const pool = new WorkerPool({
      provider: fake.provider,
      workspaceFor: ownFolder,
      tools: () => [],
    });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("completed");
    expect(store.task(run.id, "api")).toMatchObject({ state: "completed", attempts: 2 });
    const metrics = store.events(run.id).filter((e) => e.kind === "attempt_metrics");
    expect(metrics.map((m) => [m.data.attempt, m.data.outcome, m.data.failure ?? null])).toEqual([
      [1, "retry", "unavailable"],
      [2, "completed", null],
    ]);
  });

  it("a provider that stays down is retried within the limit, then the task fails and blocks what depends on it", async () => {
    const { store, run } = setup([spec("api"), spec("ui", { dependsOn: ["api"] })]);
    const fake = provider([[[{ fail: "unavailable", message: "service unavailable" }]]]);
    const pool = new WorkerPool({
      provider: fake.provider,
      workspaceFor: ownFolder,
      tools: () => [],
    });
    expect(await new Scheduler({ store, runner: pool, maxAttempts: 3 }).run(run.id)).toBe("failed");
    expect(store.task(run.id, "api")).toMatchObject({ state: "failed", attempts: 3 });
    expect(store.task(run.id, "ui")?.state).toBe("blocked");
    expect(fake.created).toBe(3); // bounded: never a fourth model
  });

  it("Grafeno unreachable when a worker starts: it works without memory, and the run says so", async () => {
    const { store, run } = setup([spec("api")]);
    const fake = provider([[[{ say: "Done without memory." }]]]);
    const pool = new WorkerPool({
      provider: fake.provider,
      workspaceFor: ownFolder,
      tools: () => [],
      memoryFor: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:7810")),
    });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("completed");
    expect(store.task(run.id, "api")).toMatchObject({ state: "completed", attempts: 1 });
    const failed = store.events(run.id).find((e) => e.kind === "memory_failed")?.data;
    expect(failed?.at).toBe("start");
    expect(String(failed?.reason)).toContain("ECONNREFUSED");
  });

  it("Grafeno lost before a worker's checkpoint: the work stands, and the run says so", async () => {
    const { store, run } = setup([spec("api")]);
    const fake = provider([[[{ say: "Done." }]]]);
    const pool = new WorkerPool({
      provider: fake.provider,
      workspaceFor: ownFolder,
      tools: () => [],
      memoryFor: () =>
        Promise.resolve({
          tools: [],
          brief: "",
          finish: () => Promise.reject(new Error("Grafeno went away")),
        }),
    });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("completed");
    expect(store.events(run.id).some((e) => e.kind === "memory_failed")).toBe(true);
  });
});
