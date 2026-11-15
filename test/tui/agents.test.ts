import { describe, expect, it } from "vitest";
import { delegateTool } from "../../src/app/delegate.js";
import type { WorkerActivity } from "../../src/orchestrator/workers.js";
import { withActivity, withState, withTasks, withWorkers } from "../../src/tui/agents.js";

const run = "run-1";
const tasks = [
  { id: "api", title: "Write the API", state: "running" as const },
  { id: "docs", title: "Write the docs", state: "pending" as const },
];
const act = (task: string, event: WorkerActivity["event"]): WorkerActivity => ({
  worker: `w-${task}`,
  task,
  runId: run,
  event,
});

describe("sub-agents on screen", () => {
  it("are the run's tasks, one each, and keep what they did across updates", () => {
    let agents = withTasks([], run, tasks);
    expect(agents.map((a) => [a.id, a.state, a.doing])).toEqual([
      ["api", "running", "starting"],
      ["docs", "pending", "waiting"],
    ]);
    agents = withActivity(agents, act("api", { type: "text", text: "Reading " }));
    agents = withActivity(agents, act("api", { type: "text", text: "the code." }));
    agents = withTasks(agents, run, tasks);
    expect(agents[0]?.lines).toEqual([{ kind: "text", text: "Reading the code." }]);
    // Another run's sub-agents are kept apart.
    const other = withTasks(agents, "run-2", [{ id: "api", title: "x", state: "pending" }]);
    expect(other.filter((a) => a.id === "api")).toHaveLength(2);
  });

  it("say what each one is doing: writing, a tool, its result", () => {
    let agents = withTasks([], run, tasks);
    agents = withActivity(
      agents,
      act("api", {
        type: "tool_call",
        call: { id: "c1", name: "write_file", input: { path: "src/api.ts", content: "x" } },
      }),
    );
    expect(agents[0]?.doing).toContain("src/api.ts");
    expect(agents[0]?.lines.at(-1)).toMatchObject({ kind: "tool", state: "running" });
    agents = withActivity(
      agents,
      act("api", {
        type: "tool_result",
        callId: "c1",
        outcome: { content: "Permission denied\nmore", isError: true },
      }),
    );
    expect(agents[0]?.lines.at(-1)).toMatchObject({
      state: "failed",
      detail: "Permission denied",
    });
    expect(agents[0]?.doing).toBe("thinking");
    // Events that are not work (context, model info) change nothing.
    const same = withActivity(agents, act("api", { type: "context", used: 10 }));
    expect(same[0]).toBe(agents[0]);
  });

  it("follow the run: workers with their models, states with their reasons", () => {
    let agents = withTasks([], run, tasks);
    agents = withWorkers(agents, run, [
      {
        name: "w-api",
        task: "api",
        model: "sonnet",
        effort: "low",
        tier: "standard",
        started: new Date(),
      },
    ]);
    expect(agents[0]).toMatchObject({ worker: "w-api", model: "sonnet", effort: "low" });
    agents = withState(agents, run, "api", "review", "the checks failed");
    expect(agents[0]).toMatchObject({
      state: "review",
      doing: "waiting for a person",
      reason: "the checks failed",
    });
    agents = withState(agents, run, "api", "completed");
    expect(agents[0]).toMatchObject({ state: "completed", doing: "done" });
    expect(agents[0]?.reason).toBeUndefined();
  });
});

describe("the delegate tool", () => {
  it("hands the request to the launcher and gives back its report, with the plan as the approval", async () => {
    const asked: string[] = [];
    const tool = delegateTool((request) => {
      asked.push(request);
      return Promise.resolve("The sub-agents' run ended: completed.");
    });
    // No second permission box: the person approves the plan itself.
    expect(tool.permission?.({ request: "x" }).permission).toBe("free");
    const signal = new AbortController().signal;
    expect(await tool.run({ request: "  Build the API and its docs  " }, { signal })).toBe(
      "The sub-agents' run ended: completed.",
    );
    expect(asked).toEqual(["Build the API and its docs"]);
    expect(await tool.run({ request: " " }, { signal })).toMatch(/No request/);
    expect(tool.describe?.({ request: "Build it\nwith tests" })).toBe("Sub-agents: Build it");
  });
});
