import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../../src/agent/tools.js";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { route, type Catalog } from "../../src/orchestrator/router.js";
import { Scheduler } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { taskMessage, WorkerPool, type ActiveWorker } from "../../src/orchestrator/workers.js";
import type { ModelChoice, Provider, ProviderUsage } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";

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

const catalog: Catalog = {
  models: [
    { id: "default", name: "Opus 5.5 (default)" },
    { id: "haiku", name: "Haiku 5.5" },
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "opus", name: "Opus 5.5" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  tiers: { deep: ["opus", "sonnet"], standard: ["sonnet", "opus"], light: ["haiku", "sonnet"] },
};

const usageAt = (used: number): ProviderUsage => ({
  limits: [{ label: "Session", used, resets: "6:20pm" }],
  at: new Date(),
});

describe("the router", () => {
  it("routes each kind by its profile to what the provider offers", () => {
    expect(route(spec("a", { kind: "architecture" }), catalog)).toMatchObject({
      kind: "run",
      tier: "deep",
      model: "opus",
      effort: "high",
    });
    expect(route(spec("f", { kind: "frontend" }), catalog)).toMatchObject({
      model: "sonnet",
      effort: "medium",
    });
    expect(route(spec("d", { kind: "docs" }), catalog)).toMatchObject({
      tier: "light",
      model: "haiku",
      effort: "low",
    });
  });

  it("follows the planner's advice, and never sends a hard task below standard", () => {
    expect(
      route(spec("t", { kind: "tests", recommended: { tier: "deep", effort: "xhigh" } }), catalog),
    ).toMatchObject({
      model: "opus",
      effort: "xhigh",
    });
    const hard = route(spec("hard", { kind: "docs", complexity: 5 }), catalog);
    expect(hard).toMatchObject({ tier: "standard", model: "sonnet" });
    expect(hard.kind === "run" && hard.reasons.join()).toContain(
      "complexity 5 needs at least standard",
    );
  });

  it("falls back in a fixed order when a tier has no model, and lowers an effort not offered", () => {
    const small: Catalog = {
      models: [{ id: "haiku", name: "Haiku 5.5" }],
      efforts: ["low", "medium"],
      tiers: { deep: ["opus"], standard: ["sonnet"], light: ["haiku"] },
    };
    const routed = route(spec("a", { kind: "architecture" }), small);
    expect(routed).toMatchObject({ kind: "run", tier: "light", model: "haiku", effort: "medium" });
    expect(routed.kind === "run" && routed.reasons.join(" | ")).toMatch(
      /no deep model is available: using light.*effort high is not offered: medium/,
    );
  });

  it("goes lighter near the plan's limit, and holds when it is reached", () => {
    expect(
      route(spec("a", { kind: "architecture" }), catalog, { usage: usageAt(0.85) }),
    ).toMatchObject({
      tier: "standard",
      model: "sonnet",
    });
    expect(route(spec("a"), catalog, { usage: usageAt(0.97) })).toEqual({
      kind: "hold",
      reason: "Session is 97% used",
      resets: "6:20pm",
    });
  });
});

/** A provider whose models answer from scripts, and which records what it was asked for. */
function fakeProvider(script: (choice: ModelChoice) => FakeTurn[], usage?: ProviderUsage) {
  const created: ModelChoice[] = [];
  const provider: Provider = {
    id: "fake",
    name: "Fake",
    signIn: "",
    tiers: catalog.tiers,
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () => Promise.resolve(catalog.models),
    efforts: () => catalog.efforts,
    usage: () => Promise.resolve(usage),
    modelName: (id) => id,
    create: (choice) => {
      created.push(choice);
      return new FakeModel({ turns: script(choice) });
    },
  };
  return { provider, created };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-workers-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold the folder a moment longer.
  }
});

function setup(tasks: TaskSpec[]) {
  const store = new SqliteStore();
  const plan: Plan = { goal: "g", risks: [], tasks };
  const run = store.createRun(
    "r",
    plan,
    tasks.map((t) => t.id),
  );
  return { store, run };
}

/** Each task in a folder of its own, as worktrees will give them. */
function ownFolder(task: { id: string }): Promise<Workspace> {
  const folder = join(dir, task.id);
  mkdirSync(folder, { recursive: true });
  return Promise.resolve(new Workspace(folder));
}

describe("the worker pool", () => {
  it("runs three workers at once, each with the model and effort its task needs, in its own folder", async () => {
    const { store, run } = setup([
      spec("design", { kind: "architecture" }),
      spec("screens", { kind: "frontend" }),
      spec("readme", { kind: "docs" }),
    ]);
    const { provider, created } = fakeProvider((choice) => [
      [{ wait: 60 }, { say: `Done with ${choice.model ?? "?"} at ${choice.effort ?? "?"}.` }],
    ]);
    const roots = new Map<string, string>();
    const whereTool = (workspace: Workspace): Tool => ({
      name: "where",
      description: "Says the workspace.",
      inputSchema: { type: "object", properties: {} },
      writes: false,
      run: () => workspace.root,
    });
    let most = 0;
    const pool = new WorkerPool({
      provider,
      workspaceFor: async (task) => {
        const workspace = await ownFolder(task);
        roots.set(task.id, workspace.root);
        return workspace;
      },
      tools: (workspace) => [whereTool(workspace)],
      onChange: (active: readonly ActiveWorker[]) => {
        most = Math.max(most, active.length);
      },
    });
    expect(await new Scheduler({ store, runner: pool, maxWorkers: 3 }).run(run.id)).toBe(
      "completed",
    );
    expect(most).toBe(3);
    expect(created).toEqual(
      expect.arrayContaining([
        { model: "opus", effort: "high" },
        { model: "sonnet", effort: "medium" },
        { model: "haiku", effort: "low" },
      ]),
    );
    const design = store.task(run.id, "design");
    expect(design).toMatchObject({ state: "completed", model: "opus", effort: "high" });
    expect(design?.worker).toMatch(/^worker-.*-design-1$/);
    expect(design?.reason).toBe("Done with opus at high.");
    expect(new Set(roots.values()).size).toBe(3);
  });

  it("gives a task what its dependencies came to, and nothing more", async () => {
    const { store, run } = setup([
      spec("contracts", { kind: "architecture" }),
      spec("api", { dependsOn: ["contracts"] }),
    ]);
    const seen: string[] = [];
    const { provider } = fakeProvider(() => [
      (context) => {
        seen.push(context.message);
        return [
          {
            say: context.message.includes("# Task contracts")
              ? "Users have id and email."
              : "API done.",
          },
        ];
      },
    ]);
    const pool = new WorkerPool({ provider, workspaceFor: ownFolder, tools: () => [] });
    await new Scheduler({ store, runner: pool }).run(run.id);
    const apiMessage = seen.find((m) => m.includes("# Task api")) ?? "";
    expect(apiMessage).toContain("Done before you");
    expect(apiMessage).toContain("Task contracts (contracts): Users have id and email.");
    expect(apiMessage).toContain("the command `npm test` exits 0");
  });

  it("refuses a tool that needs permission unless the policy allows it", async () => {
    const { store, run } = setup([spec("w")]);
    let wrote = false;
    const writer: Tool = {
      name: "write_it",
      description: "Writes.",
      inputSchema: { type: "object", properties: {} },
      writes: true,
      run: () => {
        wrote = true;
        return "written";
      },
    };
    const { provider } = fakeProvider(() => [
      [
        { call: "write_it" },
        { say: (context) => `tool said: ${context.results[0]?.content ?? ""}` },
      ],
    ]);
    const pool = new WorkerPool({ provider, workspaceFor: ownFolder, tools: () => [writer] });
    await new Scheduler({ store, runner: pool }).run(run.id);
    expect(wrote).toBe(false);
    expect(store.task(run.id, "w")?.reason).toMatch(
      /tool said: .*(did not allow|not allowed|refused)/i,
    );
  });

  it("pauses the run when the provider's limit is reached during a task", async () => {
    const { store, run } = setup([spec("big")]);
    const { provider } = fakeProvider(() => [[{ fail: "usage_limit", message: "limit reached" }]]);
    const pool = new WorkerPool({ provider, workspaceFor: ownFolder, tools: () => [] });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("paused");
    expect(store.task(run.id, "big")).toMatchObject({ state: "ready", attempts: 0 });
  });

  it("holds before starting any model when the plan is nearly used up", async () => {
    const { store, run } = setup([spec("a")]);
    const { provider, created } = fakeProvider(() => [[{ say: "x" }]], usageAt(0.99));
    const pool = new WorkerPool({ provider, workspaceFor: ownFolder, tools: () => [] });
    expect(await new Scheduler({ store, runner: pool }).run(run.id)).toBe("paused");
    expect(created).toEqual([]);
  });

  it("retries a worker that ran out of steps, telling it why", async () => {
    const { store, run } = setup([spec("long")]);
    const messages: string[] = [];
    let calls = 0;
    const { provider } = fakeProvider(() => [
      (context) => {
        messages.push(context.message);
        calls++;
        return calls === 1 ? [{ say: "partial" }, { stop: "max_steps" }] : [{ say: "finished" }];
      },
    ]);
    const pool = new WorkerPool({ provider, workspaceFor: ownFolder, tools: () => [] });
    await new Scheduler({ store, runner: pool }).run(run.id);
    expect(store.task(run.id, "long")).toMatchObject({ state: "completed", attempts: 2 });
    expect(messages[1]).toContain("Your last attempt did not finish");
    expect(messages[1]).toContain("step limit");
  });
});

describe("taskMessage", () => {
  it("says the task, how it is checked, what it builds on and why the last attempt stopped", () => {
    const message = taskMessage(
      spec("api", {
        acceptance: [
          { check: "command", run: "npm test" },
          { check: "files", exist: ["src/api.ts"] },
        ],
      }),
      {
        runId: "r",
        attempt: 2,
        signal: new AbortController().signal,
        inputs: [{ id: "contracts", title: "Contracts", summary: "User { id, email }" }],
        previous: "timed out after 60 s",
        assign: () => undefined,
      },
    );
    expect(message).toContain("# Task api");
    expect(message).toContain("- the command `npm test` exits 0");
    expect(message).toContain("- these files exist: src/api.ts");
    expect(message).toContain("- Contracts (contracts): User { id, email }");
    expect(message).toContain("timed out after 60 s");
  });
});
