import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import { routeAcross, type Catalog, type ProviderEntry } from "../../src/orchestrator/router.js";
import type { AttemptContext } from "../../src/orchestrator/scheduler.js";
import type { TaskRecord } from "../../src/orchestrator/store.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider, ProviderUsage } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";

const catalog = (prefix: string): Catalog => ({
  models: [
    { id: `${prefix}-big`, name: "Big" },
    { id: `${prefix}-mid`, name: "Mid" },
    { id: `${prefix}-small`, name: "Small" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: { deep: [`${prefix}-big`], standard: [`${prefix}-mid`], light: [`${prefix}-small`] },
});
const usage = (used: number, resets?: string): ProviderUsage => ({
  limits: [{ label: "5 hours", used, ...(resets ? { resets } : {}) }],
  at: new Date(),
});
const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: "t",
  title: "T",
  description: "d",
  kind: "backend",
  dependsOn: [],
  complexity: 2,
  capabilities: ["code"],
  touches: ["a.txt"],
  acceptance: [{ check: "files", exist: ["a.txt"] }],
  parallelSafe: true,
  ...over,
});
const entry = (id: string, used?: number, resets?: string): ProviderEntry => ({
  id,
  catalog: catalog(id),
  ...(used === undefined ? {} : { usage: usage(used, resets) }),
});

describe("routeAcross", () => {
  it("gives a task to the first provider with room, its model by tier", () => {
    const route = routeAcross(spec(), [entry("claude", 0.1), entry("codex", 0)]);
    expect(route).toMatchObject({
      kind: "run",
      provider: "claude",
      model: "claude-big",
      tier: "deep",
    });
  });

  it("sends a task kind to the provider set for it", () => {
    const route = routeAcross(spec({ kind: "tests" }), [entry("claude"), entry("codex")], {
      providerFor: { tests: "codex" },
    });
    expect(route).toMatchObject({ provider: "codex", model: "codex-small" });
    expect(route.kind === "run" && route.reasons[0]).toBe("tests tasks go to codex");
  });

  it("near a limit, moves to another provider before going a tier lighter", () => {
    const route = routeAcross(spec(), [entry("claude", 0.85), entry("codex", 0.2)]);
    expect(route).toMatchObject({ provider: "codex", tier: "deep", model: "codex-big" });
    expect(route.kind === "run" && route.reasons[0]).toBe("claude is near its limit");
  });

  it("when every provider is near its limit, the one with most room takes it, lighter", () => {
    const route = routeAcross(spec(), [entry("claude", 0.9), entry("codex", 0.82)]);
    expect(route).toMatchObject({ provider: "codex", tier: "standard", model: "codex-mid" });
  });

  it("holds when every provider has reached its limit, or none is ready", () => {
    const route = routeAcross(spec(), [entry("claude", 0.97, "at 3pm"), entry("codex", 0.99)]);
    expect(route).toMatchObject({ kind: "hold", resets: "at 3pm" });
    expect(routeAcross(spec(), [])).toMatchObject({ kind: "hold", reason: "no provider is ready" });
  });
});

/** A provider whose models run a script, and say where they ran. */
function provider(id: string, turn: FakeTurn, made: string[]): Provider {
  return {
    id,
    name: id,
    signIn: "",
    tiers: catalog(id).tiers,
    features: {
      agentTools: true,
      streaming: true,
      keepsConversation: true,
      usageReport: false,
      nonInteractive: true,
    },
    status: () => Promise.resolve({ installed: true, signedIn: true, version: "1", detail: "ok" }),
    models: () => Promise.resolve(catalog(id).models),
    efforts: () => ["low", "medium", "high"],
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: (choice) => {
      made.push(`${id}:${choice.model ?? "default"}`);
      return new FakeModel({ turns: [turn] });
    },
  };
}

const record = (over: Partial<TaskSpec> = {}): TaskRecord => ({
  runId: "run-1",
  id: "t",
  spec: spec(over),
  state: "running",
  attempts: 1,
  updated: "",
});

function context(notes: { kind: string; data: Record<string, unknown> }[]): AttemptContext {
  return {
    runId: "run-1",
    attempt: 1,
    signal: new AbortController().signal,
    inputs: [],
    assign: () => undefined,
    note: (kind: string, data: Record<string, unknown>) => {
      notes.push({ kind, data });
    },
  };
}

describe("WorkerPool with several providers", () => {
  const limit: FakeTurn = [{ fail: "usage_limit", message: "You've hit your usage limit." }];
  const ok: FakeTurn = [{ say: "done" }];

  it("sets aside a provider at its limit and gives the task to another, without spending an attempt", async () => {
    const made: string[] = [];
    const pool = new WorkerPool({
      provider: provider("claude", limit, made),
      providers: [provider("claude", limit, made), provider("codex", ok, made)],
      workspaceFor: () => Promise.resolve(new Workspace(tmpdir())),
      tools: () => [],
    });
    const notes: { kind: string; data: Record<string, unknown> }[] = [];
    const first = await pool.run(record(), context(notes));
    expect(first.status).toBe("moved");
    expect(notes.map((n) => n.kind)).toContain("provider_set_aside");
    const second = await pool.run(record(), context(notes));
    expect(second.status).toBe("completed");
    expect(made).toEqual(["claude:claude-big", "codex:codex-big"]);
  });

  it("never moves a task with an irreversible effect in flight", async () => {
    const made: string[] = [];
    const pool = new WorkerPool({
      provider: provider("claude", limit, made),
      providers: [provider("claude", limit, made), provider("codex", ok, made)],
      workspaceFor: () => Promise.resolve(new Workspace(tmpdir())),
      tools: () => [],
      effectInFlight: () => true,
    });
    const notes: { kind: string; data: Record<string, unknown> }[] = [];
    expect((await pool.run(record(), context(notes))).status).toBe("quota");
    expect(notes.map((n) => n.kind)).toContain("not_moved");
  });

  it("waits, as in phase A, when no other provider is ready", async () => {
    const made: string[] = [];
    const signedOut: Provider = {
      ...provider("codex", ok, made),
      status: () => Promise.resolve({ installed: true, signedIn: false, detail: "sign in" }),
    };
    const pool = new WorkerPool({
      provider: provider("claude", limit, made),
      providers: [provider("claude", limit, made), signedOut],
      workspaceFor: () => Promise.resolve(new Workspace(tmpdir())),
      tools: () => [],
    });
    expect((await pool.run(record(), context([]))).status).toBe("quota");
  });
});

describe("the orchestrator with two providers", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-multi-"));
    repo = join(dir, "project");
    mkdirSync(repo);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "# Shop\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may hold a just-used folder for a moment.
    }
  });

  it("finishes the run on the second provider when the first hits its limit midway", async () => {
    const plan = {
      goal: "Two files",
      risks: [],
      tasks: ["one", "two"].map((id, index) => ({
        id,
        title: `Write ${id}`,
        description: `Create ${id}.txt.`,
        kind: "backend",
        dependsOn: index === 1 ? ["one"] : [],
        complexity: 1,
        capabilities: ["code"],
        touches: [`${id}.txt`],
        acceptance: [{ check: "files", exist: [`${id}.txt`] }],
        parallelSafe: true,
      })),
    };
    const made: string[] = [];
    let claudeTurns = 0;
    const writer =
      (who: string): FakeTurn =>
      (c) => {
        if (c.system.includes("You are the planner")) {
          return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
        }
        if (who === "claude" && ++claudeTurns > 1) {
          return [{ fail: "usage_limit", message: "Claude usage limit reached." }];
        }
        const id = /Write (\w+)/.exec(c.message)?.[1] ?? "x";
        return [
          { call: "write_file", input: { path: `${id}.txt`, content: `${id} by ${who}\n` } },
          { say: "Done." },
        ];
      };
    const claude = provider("claude", writer("claude"), made);
    const codex = provider("codex", writer("codex"), made);
    const orchestrator = new Orchestrator({
      provider: claude,
      providers: [claude, codex],
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
    });
    const planned = await orchestrator.plan("Two files");
    const { run } = await orchestrator.start("Two files", planned);
    expect(await orchestrator.run(run.id)).toBe("completed");

    const branch = orchestrator.integrationBranch(run.id);
    expect(git("show", `${branch}:one.txt`)).toBe("one by claude");
    expect(git("show", `${branch}:two.txt`)).toBe("two by codex");
    const report = orchestrator.report(run.id);
    expect(report.tasks.find((t) => t.task === "two")?.attempts).toBe(1); // the moved one was given back
    const events = orchestrator.store.events(run.id);
    expect(
      events.some((e) => e.kind === "provider_set_aside" && e.data.provider === "claude"),
    ).toBe(true);
    expect(events.filter((e) => e.kind === "routed").map((e) => e.data.provider)).toEqual([
      "claude",
      "claude",
      "codex",
    ]);
    // The registry keeps what it read, with its date, in the data folder.
    expect(existsSync(join(dir, "data", "capabilities.json"))).toBe(true);
    orchestrator.close();
  });
});
