import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { Scheduler } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { describeReport, runReport } from "../../src/orchestrator/telemetry.js";
import {
  WorkerPool,
  type ContextPolicy,
  type WorkerMemory,
} from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-context-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a just-used folder for a moment.
  }
});

function spec(id: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}.`,
    kind: "backend",
    dependsOn: [],
    complexity: 3,
    capabilities: ["code"],
    touches: [`src/${id}.ts`],
    acceptance: [{ check: "command", run: "npm test" }],
    parallelSafe: true,
    ...extra,
  };
}

/** A provider whose n-th model (one per session) answers with the n-th script. */
function sessions(scripts: FakeTurn[][]) {
  let created = 0;
  const messages: string[][] = [];
  const provider: Provider = {
    id: "fake",
    name: "Fake",
    signIn: "",
    tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () => Promise.resolve([{ id: "m", name: "M" }]),
    efforts: () => ["low", "medium", "high"],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: () => {
      const mine = created++;
      messages[mine] = [];
      const script = scripts[mine] ?? [[{ say: "no more sessions" }]];
      return new FakeModel({
        turns: script.map((turn) => (context) => {
          messages[mine]?.push(context.message);
          return typeof turn === "function" ? turn(context) : turn;
        }),
      });
    },
  };
  return { provider, messages, created: () => created };
}

function runOne(
  provider: Provider,
  context: ContextPolicy,
  extra: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {},
) {
  const store = new SqliteStore();
  const plan: Plan = { goal: "g", risks: [], tasks: [spec("api")] };
  const run = store.createRun("r", plan, ["api"]);
  const folder = join(dir, "api");
  mkdirSync(folder, { recursive: true });
  const pool = new WorkerPool({
    provider,
    workspaceFor: () => Promise.resolve(new Workspace(folder)),
    tools: () => [],
    context,
    changedFiles: () => Promise.resolve(["src/api.ts", "src/api.test.ts"]),
    ...extra,
  });
  return { store, run, done: new Scheduler({ store, runner: pool }).run(run.id) };
}

describe("the context lifecycle", () => {
  it("renews a full session between rounds, from the worker's progress and the files changed", async () => {
    const { provider, messages, created } = sessions([
      [
        [{ context: 170_000, window: 200_000 }, { say: "half way" }, { stop: "max_steps" }],
        [
          {
            say: "Done: the handler in src/api.ts. Left: error cases. Decided: 404 for unknown ids.",
          },
        ],
      ],
      [[{ context: 20_000, window: 200_000 }, { say: "All done." }]],
    ]);
    const progress: string[] = [];
    const memory: WorkerMemory = {
      tools: [],
      progress: (summary) => {
        progress.push(summary);
        return Promise.resolve();
      },
    };
    const { store, run, done } = runOne(provider, {}, { memoryFor: () => Promise.resolve(memory) });
    expect(await done).toBe("completed");
    expect(created()).toBe(2);
    expect(messages[0]?.[1]).toContain("Your session will be renewed");
    const fresh = messages[1]?.[0] ?? "";
    expect(fresh).toContain("# Task api");
    expect(fresh).toContain("Progress so far");
    expect(fresh).toContain("404 for unknown ids");
    expect(fresh).toContain("- src/api.ts");
    expect(fresh).not.toContain("half way");
    expect(progress[0]).toContain("Left: error cases");
    const renewed = store.events(run.id).find((e) => e.kind === "context_renewed");
    expect(renewed?.data).toMatchObject({
      used: 170_000,
      window: 200_000,
      estimated: false,
      files: 2,
    });
    const metrics = store.events(run.id).find((e) => e.kind === "attempt_metrics")?.data;
    expect(metrics).toMatchObject({
      renewals: 1,
      rounds: 2,
      outcome: "completed",
      contextPeak: 170_000,
    });
  });

  it("goes on in the same session while the context has room, warning past 60%", async () => {
    const { provider, created } = sessions([
      [[{ context: 130_000, window: 200_000 }, { stop: "max_steps" }], [{ say: "finished" }]],
    ]);
    const { store, run, done } = runOne(provider, {});
    expect(await done).toBe("completed");
    expect(created()).toBe(1);
    expect(store.events(run.id).some((e) => e.kind === "context_warning")).toBe(true);
    expect(store.events(run.id).some((e) => e.kind === "context_renewed")).toBe(false);
  });

  it("renews on an assumed window when the provider does not say it, and says it was assumed", async () => {
    const { provider } = sessions([
      [[{ context: 90_000 }, { stop: "max_steps" }], [{ say: "progress" }]],
      [[{ say: "done" }]],
    ]);
    const { store, run, done } = runOne(provider, { assumedWindow: 100_000 });
    expect(await done).toBe("completed");
    expect(store.events(run.id).find((e) => e.kind === "context_renewed")?.data).toMatchObject({
      window: 100_000,
      estimated: true,
    });
    expect(runReport(store, run.id).estimated).toBe(true);
  });

  it("keeps an attempt to its token budget", async () => {
    const { provider } = sessions([
      [[{ say: "x".repeat(400) }, { stop: "max_steps" }], [{ say: "more" }]],
    ]);
    const { store, run, done } = runOne(provider, {}, { attemptTokens: () => 10 });
    expect(await done).toBe("failed");
    expect(store.task(run.id, "api")?.reason).toMatch(/spent its 10 tokens/);
  });
});

describe("telemetry", () => {
  it("reports a run by the numbers, per task and per model, with no text of the work", async () => {
    const { provider } = sessions([
      [[{ say: "SECRET-PHRASE in the answer" }]],
      [[{ say: "the other task" }]],
    ]);
    const store = new SqliteStore();
    const tasks = [spec("a", { kind: "architecture" }), spec("b", { kind: "docs" })];
    const run = store.createRun("r", { goal: "g", risks: [], tasks }, ["a", "b"]);
    const pool = new WorkerPool({
      provider,
      workspaceFor: () => Promise.resolve(new Workspace(dir)),
      tools: () => [],
    });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("completed");
    const report = runReport(store, run.id);
    expect(report.totals.attempts).toBe(2);
    expect(report.tasks.map((t) => [t.task, t.state, t.attempts])).toEqual([
      ["a", "completed", 1],
      ["b", "completed", 1],
    ]);
    expect(report.byModel).toEqual([
      expect.objectContaining({ model: "m", effort: "high", attempts: 1, completed: 1 }),
      expect.objectContaining({ model: "m", effort: "low", attempts: 1, completed: 1 }),
    ]);
    expect(report.totals.outputTokens).toBeGreaterThan(0);
    const metrics = store.events(run.id).filter((e) => e.kind === "attempt_metrics");
    expect(JSON.stringify(metrics)).not.toContain("SECRET-PHRASE");
    expect(describeReport(report)[0]).toBe(`Run ${run.id}: completed`);
  });
});
