import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/agent/tools.js";
import { limitReached, runUsage } from "../../src/orchestrator/limits.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { Scheduler, type TaskRunner } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { describeReport, runReport } from "../../src/orchestrator/telemetry.js";

function spec(id: string): TaskSpec {
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
  };
}

function setup(ids: string[]) {
  const store = new SqliteStore();
  const plan: Plan = { goal: "g", risks: [], tasks: ids.map(spec) };
  return { store, run: store.createRun("r", plan, ids) };
}

/** A runner whose every attempt reports what it spent, and how it ended. */
function spending(tokens: number, outcomes: ("completed" | "retry")[] = []): TaskRunner {
  let calls = 0;
  return {
    run: (task, context) => {
      const outcome = outcomes[calls++] ?? "completed";
      context.note("attempt_metrics", {
        task: task.id,
        inputTokens: tokens,
        outputTokens: 0,
        ms: 60_000,
        outcome,
      });
      return Promise.resolve(
        outcome === "completed" ? { status: "completed" } : { status: "retry", reason: "flaky" },
      );
    },
  };
}

describe("runUsage and limitReached", () => {
  it("count what the run's attempts recorded, retries the model's doing only", () => {
    const { store, run } = setup(["a"]);
    const note = (data: Record<string, unknown>) => {
      store.event(run.id, "attempt_metrics", data, "a");
    };
    note({ inputTokens: 1000, outputTokens: 200, ms: 30_000, outcome: "retry" });
    note({ inputTokens: 500, outputTokens: 100, ms: 30_000, outcome: "quota" });
    note({ inputTokens: 900, outputTokens: 300, ms: 60_000, outcome: "completed" });
    expect(runUsage(store, run.id)).toEqual({ tokens: 3000, workMs: 120_000, retries: 1 });
    expect(limitReached(store, run.id, {})).toBeUndefined();
    expect(limitReached(store, run.id, { tokens: 3000 })).toBe(
      "the run's token limit is reached: 3,000 of 3,000 reported tokens (resume with a higher --max-tokens)",
    );
    expect(limitReached(store, run.id, { workMs: 120_000 })).toMatch(
      /work-time limit is reached: 2 of 2 minutes/,
    );
    expect(limitReached(store, run.id, { retries: 1 })).toMatch(
      /retry limit is reached: 1 of 1 failed attempts/,
    );
    expect(limitReached(store, run.id, { tokens: 10_000, retries: 5 })).toBeUndefined();
  });
});

describe("a run that reaches a limit", () => {
  it("pauses: what runs finishes, nothing new starts, and it says which limit", async () => {
    const { store, run } = setup(["a", "b", "c"]);
    const scheduler = new Scheduler({
      store,
      runner: spending(600),
      maxWorkers: 1,
      limit: (id) => limitReached(store, id, { tokens: 1000 }),
    });
    expect(await scheduler.run(run.id)).toBe("paused");
    // a (600) and b (1200) ran; c never started.
    expect(store.tasks(run.id).map((t) => [t.id, t.state])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "ready"],
    ]);
    const reason = store
      .events(run.id)
      .filter((e) => e.kind === "run_reason")
      .at(-1)?.data.reason;
    expect(reason).toMatch(/token limit is reached: 1,200 of 1,000/);
  });

  it("goes on when resumed with a higher limit, keeping its count across processes", async () => {
    const { store, run } = setup(["a", "b", "c"]);
    const runner = spending(600);
    await new Scheduler({
      store,
      runner,
      maxWorkers: 1,
      limit: (id) => limitReached(store, id, { tokens: 1000 }),
    }).run(run.id);
    // Another process resumes it, still at the old limit: it stays paused.
    expect(
      await new Scheduler({
        store,
        runner,
        maxWorkers: 1,
        limit: (id) => limitReached(store, id, { tokens: 1000 }),
      }).run(run.id),
    ).toBe("paused");
    expect(
      await new Scheduler({
        store,
        runner,
        maxWorkers: 1,
        limit: (id) => limitReached(store, id, { tokens: 5000 }),
      }).run(run.id),
    ).toBe("completed");
  });

  it("pauses on the run's retries, before any task runs out of its own attempts", async () => {
    const { store, run } = setup(["a", "b"]);
    const scheduler = new Scheduler({
      store,
      runner: spending(10, ["retry", "retry", "completed"]),
      maxWorkers: 1,
      maxAttempts: 5,
      limit: (id) => limitReached(store, id, { retries: 2 }),
    });
    expect(await scheduler.run(run.id)).toBe("paused");
    expect(store.task(run.id, "a")?.state).not.toBe("failed");
  });
});

describe("the run's report", () => {
  it("shows what the orchestrating process used, when it was measured", () => {
    const { store, run } = setup(["a"]);
    store.event(run.id, "resources", { rssMb: 180, heapMb: 60, cpuUserMs: 2500, cpuSystemMs: 700 });
    const report = runReport(store, run.id);
    expect(report.resources).toEqual({ rssMb: 180, cpuMs: 3200 });
    expect(describeReport(report).join("\n")).toContain(
      "This process: 180 MB of memory, 3.2 s of CPU (the providers' processes not included).",
    );
  });
});

describe("the cap on any tool's result", () => {
  it("keeps the start and the end of a result that is too long, and says how much was left out", async () => {
    const registry = new ToolRegistry(
      [
        {
          name: "huge",
          description: "Returns a lot.",
          inputSchema: { type: "object", properties: {} },
          writes: false,
          run: () => Promise.resolve(`START${"x".repeat(300_000)}END`),
        },
      ],
      undefined,
      { maxResultChars: 1000 },
    );
    const outcome = await registry.call(
      { id: "1", name: "huge", input: {} },
      new AbortController().signal,
    );
    expect(outcome.content.startsWith("START")).toBe(true);
    expect(outcome.content.endsWith("END")).toBe(true);
    expect(outcome.content).toMatch(/\(299008 characters left out: ask for less\)/);
    expect(outcome.content.length).toBeLessThan(1100);
  });
});
