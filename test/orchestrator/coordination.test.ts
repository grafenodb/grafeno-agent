import { describe, expect, it } from "vitest";
import type { Tool } from "../../src/agent/tools.js";
import { FakeModel } from "../../src/model/index.js";
import {
  Coordinator,
  coordinationTools,
  describeCoordination,
  MAX_ACCEPTED_REQUESTS,
  modelDecider,
  type Decider,
  type WorkNote,
} from "../../src/orchestrator/coordination.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { SqliteStore } from "../../src/orchestrator/store.js";

const signal = new AbortController().signal;

function spec(id: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${id}.txt.`,
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: [`${id}.txt`],
    acceptance: [{ check: "files", exist: [`${id}.txt`] }],
    parallelSafe: true,
    ...extra,
  };
}

function setup(decide: Decider) {
  const store = new SqliteStore();
  const plan: Plan = { goal: "Write the shop", risks: [], tasks: [spec("api"), spec("ui")] };
  const run = store.createRun("Write the shop", plan, ["api", "ui"]);
  store.transition(run.id, "api", "ready");
  store.transition(run.id, "api", "running");
  store.transition(run.id, "api", "completed");
  const notes: WorkNote[] = [];
  const coordinator = new Coordinator(store, decide, (note) => notes.push(note));
  const tools = Object.fromEntries(
    coordinationTools(coordinator, run.id, "ui", "worker-ui-1").map((t) => [t.name, t]),
  ) as Record<string, Tool>;
  return { store, runId: run.id, coordinator, notes, tools };
}

const accept: Decider = () =>
  Promise.resolve({ accept: true, reason: "the API must expose prices for the UI" });
const reject: Decider = () => Promise.resolve({ accept: false, reason: "out of scope" });

describe("workers and the orchestrator", () => {
  it("a worker's progress is kept in the run and told to the interface", async () => {
    const { store, runId, notes, tools } = setup(accept);
    expect(
      await tools.report_progress?.run(
        { summary: "Found the cart component", found: ["it lacks prices"] },
        { signal },
      ),
    ).toBe("Reported to the orchestrator.");
    expect(notes[0]).toMatchObject({
      kind: "progress",
      task: "ui",
      report: { summary: "Found the cart component" },
    });
    expect(describeCoordination(store, runId)).toEqual([
      "- ui reported: Found the cart component (found: it lacks prices)",
    ]);
  });

  it("an accepted rerun becomes a task of the plan, saying who asked and why", async () => {
    const { store, runId, tools } = setup(accept);
    const answer = await tools.request_work?.run(
      {
        kind: "rerun",
        task: "api",
        reason: "the API has no prices",
        what: "Add prices to every product",
      },
      { signal },
    );
    expect(answer).toContain("Accepted by the orchestrator: the API must expose prices for the UI");
    expect(answer).toContain("api-again-2");
    const added = store.tasks(runId).find((t) => t.id === "api-again-2");
    expect(added?.state).toBe("pending");
    expect(added?.spec.title).toBe("Again: Write api");
    expect(added?.spec.description).toContain("worker-ui-1 (on ui) asked: the API has no prices");
    expect(added?.spec.description).toContain("Add prices to every product");
    expect(store.run(runId)?.plan.tasks.map((t) => t.id)).toContain("api-again-2");
    expect(describeCoordination(store, runId).at(-1)).toContain(
      "ui asked for a rerun of api (the API has no prices): accepted as api-again-2",
    );
  });

  it("a rejected request comes back to the worker with the reason", async () => {
    const { store, runId, tools } = setup(reject);
    const answer = await tools.request_work?.run(
      { kind: "new", reason: "nicer colours", what: "Restyle every page" },
      { signal },
    );
    expect(answer).toBe(
      "Rejected by the orchestrator: out of scope. Do not ask again for the same; go on with your own task.",
    );
    expect(store.tasks(runId)).toHaveLength(2);
  });

  it("code refuses what makes no sense before any model is asked, and caps a run's requests", async () => {
    let asked = 0;
    const counting: Decider = () => {
      asked++;
      return Promise.resolve({ accept: true, reason: "ok" });
    };
    const { coordinator, runId } = setup(counting);
    const base = { runId, from: "api", worker: "w", reason: "r", what: "w" } as const;
    expect(await coordinator.request({ ...base, kind: "rerun", task: "nope" })).toMatchObject({
      accept: false,
      reason: "there is no task nope",
    });
    expect(await coordinator.request({ ...base, kind: "rerun", task: "ui" })).toMatchObject({
      accept: false,
      reason: "ui has not run yet: it will run as planned",
    });
    expect(asked).toBe(0);
    for (let i = 0; i < MAX_ACCEPTED_REQUESTS; i++) {
      expect(
        (await coordinator.request({ ...base, kind: "new", what: `piece ${String(i)}` })).accept,
      ).toBe(true);
    }
    const more = await coordinator.request({ ...base, kind: "new", what: "one more" });
    expect(more.accept).toBe(false);
    expect(more.reason).toContain("the most allowed");
  });

  it("the orchestrator's model decides, by JSON", async () => {
    const decide = modelDecider(() =>
      Promise.resolve(
        new FakeModel({
          turns: [
            [
              {
                say: '```json\n{"accept": true, "reason": "the goal needs it", "complexity": 3, "acceptance": [{"check": "files", "exist": ["prices.json"]}]}\n```',
              },
            ],
          ],
        }),
      ),
    );
    const { store, runId, tools } = setup(decide);
    await tools.request_work?.run(
      {
        kind: "new",
        reason: "prices are missing",
        what: "Write prices.json",
        files: ["prices.json"],
      },
      { signal },
    );
    const added = store.tasks(runId).find((t) => t.id === "ui-more-2");
    expect(added?.spec).toMatchObject({
      complexity: 3,
      touches: ["prices.json"],
      acceptance: [{ check: "files", exist: ["prices.json"] }],
    });
  });
});
