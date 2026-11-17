import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import {
  explore,
  exploreOn,
  exploreShare,
  routerMode,
  suggest,
  type RuleChoice,
} from "../../src/orchestrator/learned.js";
import type { AttemptRecord, TaskOutcome } from "../../src/orchestrator/metrics.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import type { Catalog } from "../../src/orchestrator/router.js";
import { computeStats, type CellStats } from "../../src/orchestrator/stats.js";
import { describeReport } from "../../src/orchestrator/telemetry.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";

const catalog: Catalog = {
  models: [
    { id: "big", name: "Big" },
    { id: "mid", name: "Mid" },
    { id: "small", name: "Small" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: { deep: ["big"], standard: ["mid"], light: ["small"] },
};

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: "t",
  title: "T",
  description: "d",
  kind: "backend",
  dependsOn: [],
  complexity: 3,
  capabilities: ["code"],
  touches: ["a.txt"],
  acceptance: [{ check: "files", exist: ["a.txt"] }],
  parallelSafe: true,
  ...over,
});

let next = 0;
/** `n` finished tasks of a cell on one arm, `clean` of them clean, each costing `tokens`. */
function arm(
  n: number,
  clean: number,
  tokens: number,
  model: string,
  effort = "medium",
  provider = "p",
  kind = "backend",
  complexity = 3,
): { attempts: AttemptRecord[]; outcomes: TaskOutcome[] } {
  const attempts: AttemptRecord[] = [];
  const outcomes: TaskOutcome[] = [];
  for (let i = 0; i < n; i++) {
    const task = `t${String(++next)}`;
    attempts.push({
      run: "r",
      task,
      attempt: 1,
      project: "x",
      at: "2026-11-15T10:00:00Z",
      kind,
      complexity,
      provider,
      model,
      effort,
      tier: "standard",
      ms: 1000,
      rounds: 1,
      renewals: 0,
      inputTokens: tokens,
      outputTokens: 0,
      cacheTokens: 0,
      contextPeak: 0,
      window: 200_000,
      windowEstimated: false,
      outcome: "completed",
      explored: false,
    });
    outcomes.push({
      run: "r",
      task,
      project: "x",
      at: "2026-11-15T10:00:00Z",
      kind,
      complexity,
      state: "completed",
      attempts: 1,
      checksFailed: i < clean ? 0 : 1,
      merged: true,
      conflict: false,
    });
  }
  return { attempts, outcomes };
}

function cells(...arms: ReturnType<typeof arm>[]): CellStats[] {
  return computeStats(
    arms.flatMap((a) => a.attempts),
    arms.flatMap((a) => a.outcomes),
  );
}

const rule: RuleChoice = { provider: "p", model: "big", effort: "medium", tier: "deep" };

describe("routerMode", () => {
  it("is learned by default, and takes rules or shadow", () => {
    expect(routerMode(undefined)).toBe("learned");
    expect(routerMode(" Shadow ")).toBe("shadow");
    expect(routerMode("rules")).toBe("rules");
    expect(() => routerMode("smart")).toThrow(/AGENT_ROUTER must be one of/);
  });
});

describe("suggest: when a learned arm replaces the rules' choice", () => {
  it("replaces it with an arm as good and cheaper, both with enough tasks", () => {
    const s = suggest(
      spec(),
      rule,
      cells(arm(12, 9, 1000, "big"), arm(12, 12, 300, "mid")),
      catalog,
    );
    expect(s).toMatchObject({
      replace: true,
      cell: "backend · medium",
      rule: "p/big · medium",
      learned: "p/mid · medium",
      model: "mid",
      effort: "medium",
      tier: "standard",
    });
    expect(s.reason).toMatch(/as good and cheaper/);
  });

  it("asks for more evidence against a strong rule: 12 of 12 is not enough against 92%, 40 of 40 is", () => {
    // Wilson's lower bound at 12/12 is 76%, below 92% − 5 points; at 40/40 it is 91%.
    const strong = arm(12, 11, 1000, "big");
    expect(suggest(spec(), rule, cells(strong, arm(12, 12, 300, "mid")), catalog).replace).toBe(
      false,
    );
    expect(suggest(spec(), rule, cells(strong, arm(40, 40, 300, "mid")), catalog).replace).toBe(
      true,
    );
  });

  it("replaces a weak arm with a clearly better one, even if dearer", () => {
    const s = suggest(
      spec(),
      rule,
      cells(arm(12, 4, 300, "big"), arm(12, 12, 900, "mid")),
      catalog,
    );
    expect(s).toMatchObject({ replace: true, model: "mid" });
    expect(s.reason).toMatch(/clearly better/);
  });

  it("keeps the rules' arm when the other is cheaper but worse", () => {
    const s = suggest(
      spec(),
      rule,
      cells(arm(12, 12, 1000, "big"), arm(12, 7, 200, "mid")),
      catalog,
    );
    expect(s.replace).toBe(false);
    expect(s.reason).toMatch(/holds: 100% clean over 12 tasks/);
  });

  it("never concludes from small samples, on either side", () => {
    expect(
      suggest(spec(), rule, cells(arm(9, 9, 1000, "big"), arm(12, 12, 100, "mid")), catalog).reason,
    ).toMatch(/has 9 backend · medium tasks: not enough to compare/);
    expect(
      suggest(spec(), rule, cells(arm(12, 12, 1000, "big"), arm(9, 9, 100, "mid")), catalog).reason,
    ).toMatch(/no other p arm has enough/);
  });

  it("never mixes cells: other kinds and complexities say nothing", () => {
    const other = arm(20, 20, 10, "mid", "medium", "p", "docs", 1);
    expect(suggest(spec(), rule, cells(arm(12, 12, 1000, "big"), other), catalog).replace).toBe(
      false,
    );
  });

  it("stays on the provider the rules chose, and on what is offered now", () => {
    const elsewhere = arm(12, 12, 10, "mid", "medium", "q");
    expect(suggest(spec(), rule, cells(arm(12, 12, 1000, "big"), elsewhere), catalog).replace).toBe(
      false,
    );
    const gone = arm(12, 12, 10, "retired");
    expect(suggest(spec(), rule, cells(arm(12, 12, 1000, "big"), gone), catalog).replace).toBe(
      false,
    );
  });

  it("puts the planner's recommendation first", () => {
    const s = suggest(
      spec({ recommended: { tier: "deep" } }),
      rule,
      cells(arm(12, 11, 1000, "big"), arm(12, 12, 300, "mid")),
      catalog,
    );
    expect(s).toMatchObject({ replace: false });
    expect(s.reason).toMatch(/planner recommended/);
  });

  it("says when nothing is recorded yet", () => {
    expect(suggest(spec(), rule, [], catalog).reason).toBe(
      "no finished backend · medium task on p/big · medium yet",
    );
  });
});

describe("the learned router in a worker pool", () => {
  const provider: Provider = {
    id: "p",
    name: "P",
    signIn: "",
    tiers: catalog.tiers,
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
    models: () => Promise.resolve(catalog.models),
    efforts: () => catalog.efforts,
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () => new FakeModel({ turns: [] }),
  };
  const learned = cells(arm(12, 9, 1000, "big", "high"), arm(12, 12, 300, "mid", "high"));
  const pool = (mode?: "shadow" | "learned") =>
    new WorkerPool({
      provider,
      workspaceFor: () => Promise.resolve(new Workspace(".")),
      tools: () => [],
      ...(mode ? { learning: { mode, stats: () => learned } } : {}),
    });
  // backend · medium routes to deep (big), high effort, by the default profile.
  const task = spec();

  it("in shadow, records the suggestion and keeps the rules' choice", async () => {
    const route = await pool("shadow").routeFor(task);
    expect(route).toMatchObject({ kind: "run", model: "big", tier: "deep" });
    expect(route.kind === "run" && route.suggestion).toMatchObject({
      replace: true,
      learned: "p/mid · high",
    });
  });

  it("learned, uses it, and says why among the route's reasons", async () => {
    const route = await pool("learned").routeFor(task);
    expect(route).toMatchObject({ kind: "run", model: "mid", tier: "standard", effort: "high" });
    expect(route.kind === "run" && route.reasons.at(-1)).toMatch(
      /^learned: p\/mid · high over 12 backend · medium tasks, as good and cheaper/,
    );
  });

  it("with the rules alone, says nothing of learning", async () => {
    const route = await pool().routeFor(task);
    expect(route).toMatchObject({ model: "big" });
    expect(route.kind === "run" && route.suggestion).toBeUndefined();
  });
});

describe("the run report", () => {
  const base = {
    runId: "run-1",
    state: "completed",
    tasks: [],
    byModel: [],
    totals: {
      attempts: 2,
      ms: 1000,
      inputTokens: 10,
      outputTokens: 1,
      cacheTokens: 0,
      renewals: 0,
      warnings: 0,
      questions: 0,
    },
    estimated: false,
  };

  it("says when the learned router chose, or would have chosen, differently", () => {
    expect(
      describeReport({ ...base, learned: { differed: 0, applied: 0 } }).join("\n"),
    ).not.toMatch(/learned router/);
    expect(describeReport({ ...base, learned: { differed: 2, applied: 2 } }).at(-1)).toMatch(
      /^The learned router chose 2 attempts' model from recorded runs/,
    );
    expect(describeReport({ ...base, learned: { differed: 1, applied: 0 } }).at(-1)).toMatch(
      /would have chosen differently for 1 attempt, in shadow/,
    );
  });
});

describe("exploration (C4): built, off by default", () => {
  const low = (over: Partial<TaskSpec> = {}) => spec({ kind: "docs", complexity: 1, ...over });
  const standard: RuleChoice = { provider: "p", model: "mid", effort: "low", tier: "standard" };
  const always = () => 0;

  it("is on by default (a small share), off when AGENT_ROUTER_EXPLORE says false, or set by a number", () => {
    expect(exploreOn(undefined)).toBe(true);
    expect(exploreShare(undefined)).toBe(0.1);
    expect(exploreOn("false")).toBe(false);
    expect(exploreShare("0")).toBe(0);
    expect(exploreOn(" TRUE ")).toBe(true);
    expect(exploreShare("0.2")).toBe(0.2);
    // Not a share it may take: the default.
    expect(exploreShare("0.9")).toBe(0.1);
  });

  it("only touches low-risk tasks: docs and tests of complexity 1–2, with no tier recommended", () => {
    expect(
      explore(spec({ kind: "backend", complexity: 1 }), standard, [], catalog, always),
    ).toBeUndefined();
    expect(explore(low({ complexity: 3 }), standard, [], catalog, always)).toBeUndefined();
    expect(
      explore(low({ recommended: { tier: "light" } }), standard, [], catalog, always),
    ).toBeUndefined();
    expect(explore(low({ kind: "tests" }), standard, [], catalog, always)).toBeDefined();
  });

  it("explores only a share of them", () => {
    expect(explore(low(), standard, [], catalog, () => 0.5)).toBeUndefined();
    expect(explore(low(), standard, [], catalog, () => 0.05)).toBeDefined();
  });

  it("tries a model of the same or a cheaper tier, the least sampled, never a dearer one", () => {
    const chosen = explore(low(), standard, [], catalog, always);
    expect(chosen).toMatchObject({ model: "small", tier: "light" });
    expect(chosen?.reason).toMatch(
      /exploring p\/small on a low-risk docs · low task \(0 tasks so far/,
    );
    // The lightest tier has nothing cheaper to try.
    const light: RuleChoice = { provider: "p", model: "small", effort: "low", tier: "light" };
    expect(explore(low(), light, [], catalog, always)).toBeUndefined();
  });

  it("stops exploring an arm once it has the minimum sample", () => {
    const sampled = cells(arm(10, 10, 100, "small", "low", "p", "docs", 1));
    expect(explore(low(), standard, sampled, catalog, always)).toBeUndefined();
  });

  it("in a pool, explores only when it is given, and marks the route", async () => {
    const provider: Provider = {
      id: "p",
      name: "P",
      signIn: "",
      tiers: catalog.tiers,
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
      models: () => Promise.resolve(catalog.models),
      efforts: () => catalog.efforts,
      usage: () => Promise.resolve(undefined),
      modelName: (m) => m,
      create: () => new FakeModel({ turns: [] }),
    };
    const make = (explored: boolean) =>
      new WorkerPool({
        provider,
        workspaceFor: () => Promise.resolve(new Workspace(".")),
        tools: () => [],
        profiles: { docs: { tier: "standard", effort: "low" } },
        learning: {
          mode: "learned",
          stats: () => [],
          ...(explored ? { explore: { random: always } } : {}),
        },
      });
    const off = await make(false).routeFor(low());
    expect(off).toMatchObject({ model: "mid" });
    expect(off.kind === "run" && off.explored).toBeFalsy();
    const on = await make(true).routeFor(low());
    expect(on).toMatchObject({ model: "small", tier: "light", explored: true });
    expect(on.kind === "run" && on.reasons.at(-1)).toMatch(/^explored: exploring p\/small/);
  });
});
