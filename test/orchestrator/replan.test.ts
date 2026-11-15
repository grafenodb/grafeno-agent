import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import {
  affectedBy,
  applyReplan,
  proposeReplan,
  ReplanRefused,
} from "../../src/orchestrator/replan.js";
import { Scheduler, type TaskRunner } from "../../src/orchestrator/scheduler.js";
import { isReplaced, REPLACED, SqliteStore } from "../../src/orchestrator/store.js";
import type { Provider } from "../../src/providers/types.js";

function spec(id: string, dependsOn: string[] = [], file = `${id}.txt`): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${file}.`,
    kind: "backend",
    dependsOn,
    complexity: 2,
    capabilities: ["code"],
    touches: [file],
    acceptance: [{ check: "files", exist: [file] }],
    parallelSafe: true,
  };
}

const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** A run where a completes, b fails for good, and c (after b) is blocked. */
async function failedRun() {
  const store = new SqliteStore();
  const plan: Plan = {
    goal: "Build it",
    risks: [],
    tasks: [spec("a"), spec("b", ["a"]), spec("c", ["b"])],
  };
  const run = store.createRun("Build a, b and c", plan, ["a", "b", "c"]);
  const runner: TaskRunner = {
    run: (task) =>
      Promise.resolve(
        task.id === "b"
          ? { status: "failed", reason: "b's API does not exist" }
          : { status: "completed" },
      ),
  };
  expect(await new Scheduler({ store, runner }).run(run.id)).toBe("failed");
  return { store, run };
}

describe("affectedBy", () => {
  it("is every failed task and every task that depends on one, never completed ones", async () => {
    const { store, run } = await failedRun();
    const { failed, affected } = affectedBy(store.tasks(run.id));
    expect(failed.map((t) => t.id)).toEqual(["b"]);
    expect(affected.map((t) => t.id)).toEqual(["b", "c"]);
  });
});

describe("proposeReplan", () => {
  it("asks only for what failed and depends on it, keeps completed work, and checks the answer by code", async () => {
    const { store, run } = await failedRun();
    const model = new FakeModel({
      turns: [
        [{ say: json({ goal: "Build it", tasks: [spec("b2", ["a"]), spec("c2", ["b2"])] }) }],
      ],
    });
    const proposal = await proposeReplan(store, run.id, model);
    expect(proposal.replaced).toEqual(["b", "c"]);
    expect(proposal.added.map((t) => t.id)).toEqual(["b2", "c2"]);
    expect(proposal.plan.tasks.map((t) => t.id)).toEqual(["a", "b2", "c2"]);
    expect(proposal.attempts).toBe(1);
    const asked = model.conversations[0]?.messages[0] ?? "";
    expect(asked).toMatch(/Completed \(keep, never change[\s\S]*- a \(backend\)/);
    expect(asked).toMatch(/Failed for good:[\s\S]*b \(backend\).*Why: b's API does not exist/);
    expect(asked).toMatch(/Depending on it[\s\S]*- c \(backend\)/);
  });

  it("sends back an answer that reuses an id, depends on what is replaced, or replans too much", async () => {
    const { store, run } = await failedRun();
    const model = new FakeModel({
      turns: [
        [{ say: json({ goal: "g", tasks: [spec("b", ["a"]), spec("c2", ["c"])] }) }],
        [
          {
            say: json({
              goal: "g",
              tasks: Array.from({ length: 6 }, (_, i) => spec(`n${String(i)}`, ["a"])),
            }),
          },
        ],
        [{ say: json({ goal: "g", tasks: [spec("b2", ["a"])] }) }],
      ],
    });
    const proposal = await proposeReplan(store, run.id, model);
    expect(proposal.attempts).toBe(3);
    const repairs = model.conversations[0]?.messages.slice(1).join("\n") ?? "";
    expect(repairs).toMatch(/task id "b" is already used in this run/);
    expect(repairs).toMatch(/depends on "c", which is being replaced/);
    expect(repairs).toMatch(/6 new tasks for 2 replaced: at most 5/);
  });

  it("refuses when nothing failed, while a task runs, and after the most replans", async () => {
    const store = new SqliteStore();
    const run = store.createRun("r", { goal: "g", risks: [], tasks: [spec("a")] }, ["a"]);
    const model = new FakeModel({ turns: [[{ say: "never asked" }]] });
    await expect(proposeReplan(store, run.id, model)).rejects.toThrow(/No task failed/);
    store.transition(run.id, "a", "ready");
    store.transition(run.id, "a", "running", { attempts: 1 });
    await expect(proposeReplan(store, run.id, model)).rejects.toThrow(ReplanRefused);

    const failed = await failedRun();
    failed.store.event(failed.run.id, "replanned", {});
    failed.store.event(failed.run.id, "replanned", {});
    await expect(proposeReplan(failed.store, failed.run.id, model)).rejects.toThrow(
      /replanned 2 times, the most allowed/,
    );
  });
});

describe("applying a replan", () => {
  it("cancels what it replaces as replaced, adds the new tasks, and the run then completes", async () => {
    const { store, run } = await failedRun();
    const model = new FakeModel({
      turns: [[{ say: json({ goal: "g", tasks: [spec("b2", ["a"]), spec("c2", ["b2"])] }) }]],
    });
    applyReplan(store, await proposeReplan(store, run.id, model));
    expect(store.task(run.id, "b")).toMatchObject({ state: "cancelled", reason: REPLACED });
    expect(isReplaced(store.task(run.id, "c") ?? { state: "" })).toBe(true);
    expect(store.task(run.id, "b2")?.state).toBe("pending");
    expect(store.run(run.id)?.plan.tasks.map((t) => t.id)).toEqual(["a", "b2", "c2"]);
    expect(store.events(run.id).find((e) => e.kind === "replanned")?.data).toEqual({
      replaced: ["b", "c"],
      added: ["b2", "c2"],
    });
    const runner: TaskRunner = { run: () => Promise.resolve({ status: "completed" }) };
    // Replaced tasks neither failed nor block the run: it completes.
    expect(await new Scheduler({ store, runner }).run(run.id)).toBe("completed");
  });
});

describe(
  "an orchestrator that replans on its own in the extended mode",
  { timeout: 60_000 },
  () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ga-replan-"));
    });
    afterEach(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may hold a folder a moment longer.
      }
    });

    function provider(): Provider {
      const turn: FakeTurn = (c) => {
        if (c.system.includes("revising part of a plan")) {
          return [
            {
              say: json({
                goal: "Two files",
                tasks: [spec("second-again", ["first"], "second-b.txt")],
              }),
            },
          ];
        }
        if (c.system.includes("You are the planner")) {
          return [
            {
              say: json({
                goal: "Two files",
                risks: [],
                tasks: [spec("first"), spec("second", ["first"])],
              }),
            },
          ];
        }
        // The worker of "second" never writes its file: its check fails, for good.
        if (c.message.includes('Write second"') || /Your task is "Write second"/.test(c.system)) {
          return [{ say: "I could not." }];
        }
        const file = /these files exist: (\S+)/.exec(c.message)?.[1] ?? "x.txt";
        return [{ call: "write_file", input: { path: file, content: "ok\n" } }, { say: "Done." }];
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

    it("replaces the failed task, keeps the completed one, and completes", async () => {
      const project = join(dir, "plain");
      mkdirSync(project);
      const orchestrator = new Orchestrator({
        provider: provider(),
        project: { name: "plain", path: project },
        projectRoot: project,
        dataDir: join(dir, "data"),
        mode: "extended",
        maxAttempts: 1,
        metrics: false,
      });
      const planned = await orchestrator.plan("Two files");
      const { run } = await orchestrator.start("Two files", planned);
      const replans: string[][] = [];
      const state = await orchestrator.runWithReplans(run.id, undefined, (p) => {
        replans.push([...p.replaced]);
      });
      expect(replans).toEqual([["second"]]);
      expect(state).toBe("completed");
      expect(existsSync(join(project, "second-b.txt"))).toBe(true);
      expect(orchestrator.store.task(run.id, "first")?.state).toBe("completed");
      orchestrator.close();
    });

    it("asks first in the other modes, and replans nothing when the answer is no", async () => {
      const project = join(dir, "plain2");
      mkdirSync(project);
      const orchestrator = new Orchestrator({
        provider: provider(),
        project: { name: "plain2", path: project },
        projectRoot: project,
        dataDir: join(dir, "data"),
        mode: "controlled",
        maxAttempts: 1,
        metrics: false,
      });
      const planned = await orchestrator.plan("Two files");
      const { run } = await orchestrator.start("Two files", planned);
      const asked: string[][] = [];
      const state = await orchestrator.runWithReplans(run.id, (p) => {
        asked.push([...p.replaced]);
        return Promise.resolve(false);
      });
      expect(asked).toEqual([["second"]]);
      expect(state).toBe("failed");
      expect(orchestrator.store.events(run.id).some((e) => e.kind === "replan_declined")).toBe(
        true,
      );
      orchestrator.close();
    });
  },
);
