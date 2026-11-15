import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import { workerMemory } from "../../src/orchestrator/memory.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { Scheduler, type AttemptContext } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";
import { FakeVault } from "../memory/fake-vault.js";

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

/** A fake vault that keeps memories with their props, and answers get_node with them. */
function vaultWithProps() {
  const nodes = new Map<string, { text: string; labels: unknown; props: unknown }>();
  let next = 0;
  const vault: FakeVault = new FakeVault({
    remember: (args) => {
      const id = `mem-${String(++next)}`;
      nodes.set(id, { text: String(args.text), labels: args.labels, props: args.props });
      vault.memories.push({ id, text: String(args.text), labels: args.labels });
      return { text: JSON.stringify({ id }), isError: false, data: { id } };
    },
    get_node: (args) => {
      const node = nodes.get(String(args.id));
      return node
        ? { text: JSON.stringify(node), isError: false, data: node }
        : { text: "not found", isError: true };
    },
  });
  return { vault, nodes };
}

const context = (extra: Partial<AttemptContext> = {}): AttemptContext => ({
  runId: "run-2026-11-14-abcd1234",
  attempt: 1,
  signal: new AbortController().signal,
  inputs: [],
  assign: () => undefined,
  note: () => undefined,
  ...extra,
});

describe("a worker's memory", () => {
  it("marks what the worker stores with its name, and saves its checkpoint under it", async () => {
    const { vault, nodes } = vaultWithProps();
    const memoryFor = workerMemory({ vault, project: { name: "demo" } });
    const task = {
      runId: "r",
      id: "contracts",
      spec: spec("contracts"),
      state: "running",
      attempts: 1,
      updated: "",
    } as const;
    const memory = await memoryFor(task, "worker-abcd1234-contracts-1", context());
    const remember = memory.tools.find((t) => t.name === "remember");
    await remember?.run(
      { text: "Users have an id and an email.", labels: ["Decision"] },
      { signal: new AbortController().signal },
    );
    const stored = memory.stored?.() ?? [];
    expect(stored).toHaveLength(1);
    expect(nodes.get(stored[0] ?? "")?.props).toEqual({ author: "worker-abcd1234-contracts-1" });
    await memory.finish?.("Contracts written.");
    expect(vault.called("checkpoint").at(-1)).toMatchObject({
      task: "run-2026-11-14-abcd1234: contracts",
      agent: "worker-abcd1234-contracts-1",
      summary: "Contracts written.",
      files: ["src/contracts.ts"],
    });
    // A worker needs no node of its own, nor the room's whole brief.
    expect(vault.called("palace_enter")).toEqual([]);
    expect(
      vault.called("remember").filter((a) => (a.labels as string[] | undefined)?.includes("Agent")),
    ).toEqual([]);
  });

  it("gives a worker what its dependencies stored, by id, with who stored it", async () => {
    const { vault } = vaultWithProps();
    const first = await workerMemory({ vault, project: { name: "demo" } })(
      {
        runId: "r",
        id: "contracts",
        spec: spec("contracts"),
        state: "running",
        attempts: 1,
        updated: "",
      },
      "worker-a",
      context(),
    );
    await first.tools
      .find((t) => t.name === "remember")
      ?.run(
        { text: "The API returns JSON with camelCase keys.", labels: ["Decision"] },
        { signal: new AbortController().signal },
      );
    const ids = first.stored?.() ?? [];
    const second = await workerMemory({ vault, project: { name: "demo" } })(
      { runId: "r", id: "api", spec: spec("api"), state: "running", attempts: 1, updated: "" },
      "worker-b",
      context({ inputs: [{ id: "contracts", title: "Contracts", memories: ids }] }),
    );
    expect(second.brief).toContain("Stored by the tasks you build on");
    expect(second.brief).toContain(
      `[${ids[0] ?? ""}] Decision (by worker-a): The API returns JSON with camelCase keys.`,
    );
  });
});

describe("memory through a run", () => {
  it("passes a decision from the architecture worker to the worker that builds on it", async () => {
    const { vault } = vaultWithProps();
    const store = new SqliteStore();
    const tasks = [
      spec("contracts", { kind: "architecture" }),
      spec("api", { dependsOn: ["contracts"] }),
    ];
    const plan: Plan = { goal: "g", risks: [], tasks };
    const run = store.createRun("r", plan, ["contracts", "api"]);
    const systems: string[] = [];
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      signIn: "",
      tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () => Promise.resolve([{ id: "m", name: "M" }]),
      efforts: () => [],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: () =>
        new FakeModel({
          turns: [
            (c) => {
              systems.push(c.system);
              return c.message.includes("# Task contracts")
                ? [
                    {
                      call: "remember",
                      input: {
                        text: "Orders have a status: open, paid or shipped.",
                        labels: ["Decision"],
                      },
                    },
                    { say: "Contracts decided." },
                  ]
                : [{ say: "API built on the order statuses." }];
            },
          ],
        }),
    };
    const pool = new WorkerPool({
      provider,
      workspaceFor: () => Promise.resolve(new Workspace(process.cwd())),
      tools: () => [],
      memoryFor: workerMemory({ vault, project: { name: "demo" } }),
    });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("completed");
    const apiSystem = systems.find((s) => s.includes('"Task api"')) ?? "";
    expect(apiSystem).toContain("Orders have a status: open, paid or shipped.");
    expect(store.events(run.id).filter((e) => e.kind === "memories")).toHaveLength(1);
    expect(vault.called("checkpoint").map((c) => c.agent)).toEqual([
      expect.stringMatching(/contracts-1$/),
      expect.stringMatching(/api-1$/),
    ]);
  });
});
