import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptShare, CostBook, weightedTokens } from "../../src/orchestrator/costs.js";
import { MetricsStore } from "../../src/orchestrator/metrics.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import {
  DEFAULT_AFFINITY,
  route,
  routeAcross,
  routingMode,
  type Catalog,
  type ProviderEntry,
} from "../../src/orchestrator/router.js";
import { pinnedCatalog } from "../../src/orchestrator/workers.js";
import { autoModels, autoModelsSetting } from "../../src/providers/index.js";
import type { ProviderUsage } from "../../src/providers/types.js";

const catalog: Catalog = {
  models: [
    { id: "astra", name: "Astra 6" },
    { id: "sol", name: "Sol 6.1" },
    { id: "luna", name: "Luna 6" },
  ],
  efforts: ["low", "medium", "high", "xhigh"],
  tiers: { deep: ["astra", "sol"], standard: ["sol", "astra"], light: ["luna", "sol"] },
};
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
const usage = (used: number): ProviderUsage => ({
  limits: [{ label: "5 hours", used }],
  at: new Date(),
});
const run = (r: ReturnType<typeof route>) => {
  if (r.kind !== "run") throw new Error(`held: ${r.reason}`);
  return r;
};

describe("economy routing", () => {
  it("balanced keeps the deep tier and high efforts for hard tasks, even when the planner asks", () => {
    const easy = run(
      route(spec({ recommended: { tier: "deep", effort: "high" } }), catalog, {
        routing: "balanced",
      }),
    );
    expect(easy).toMatchObject({ tier: "standard", model: "sol", effort: "medium" });
    expect(easy.reasons.join("\n")).toContain("deep is kept for hard tasks");
    const hard = run(route(spec({ complexity: 4 }), catalog, { routing: "balanced" }));
    expect(hard).toMatchObject({ tier: "deep", model: "astra", effort: "high" });
    // quality: as before.
    expect(run(route(spec(), catalog, { routing: "quality" }))).toMatchObject({
      tier: "deep",
      effort: "high",
    });
    // economy: the lightest that can do it.
    expect(run(route(spec({ kind: "frontend" }), catalog, { routing: "economy" }))).toMatchObject({
      tier: "light",
      model: "luna",
      effort: "low",
    });
  });

  it("paces as a window fills: one effort lower from half, a tier lighter from 70%", () => {
    const half = run(
      route(spec({ complexity: 4 }), catalog, { routing: "balanced", usage: usage(0.55) }),
    );
    expect(half).toMatchObject({ tier: "deep", effort: "medium" });
    expect(half.reasons.join("\n")).toContain("5 hours is 55% used: effort medium");
    const seventy = run(
      route(spec({ complexity: 4 }), catalog, { routing: "balanced", usage: usage(0.72) }),
    );
    expect(seventy).toMatchObject({ tier: "standard", model: "sol" });
    expect(route(spec(), catalog, { routing: "balanced", usage: usage(0.96) })).toMatchObject({
      kind: "hold",
    });
  });

  it("keeps a model found to spend a large share of a window off simple tasks", () => {
    const costs = new CostBook([
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.12 },
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.1 },
      { provider: "codex", model: "sol", effort: "low", quotaShare: 0.09 },
      { provider: "codex", model: "sol", effort: "low", quotaShare: 0.11 },
    ]);
    const routed = run(
      route(spec({ kind: "frontend", complexity: 3 }), catalog, {
        routing: "balanced",
        costOf: costs.costOf("codex"),
      }),
    );
    // Lower effort is expensive too: the lighter tier's model.
    expect(routed).toMatchObject({ tier: "light", model: "luna" });
    expect(routed.reasons.join("\n")).toContain(
      "sol · medium took ~11% of a window per task (2 tasks)",
    );
    // A hard task keeps it; one measurement is not enough to act on.
    expect(
      run(
        route(spec({ kind: "frontend", complexity: 4 }), catalog, {
          routing: "balanced",
          costOf: costs.costOf("codex"),
        }),
      ),
    ).toMatchObject({ model: "sol" });
    const once = new CostBook([
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.3 },
    ]);
    expect(
      run(
        route(spec({ kind: "frontend" }), catalog, {
          routing: "balanced",
          costOf: once.costOf("codex"),
        }),
      ),
    ).toMatchObject({ model: "sol", effort: "medium" });
    // Cheaper at a lower effort: only the effort comes down.
    const cheaperLow = new CostBook([
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.12 },
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.1 },
    ]);
    expect(
      run(
        route(spec({ kind: "frontend" }), catalog, {
          routing: "balanced",
          costOf: cheaperLow.costOf("codex"),
        }),
      ),
    ).toMatchObject({ model: "sol", effort: "low" });
  });

  it("never swaps models the person chose, by usage or cost; still routes among them by the task", () => {
    const chosen = pinnedCatalog(catalog.models, catalog.tiers, ["sol", "astra"]);
    expect(chosen.tiers).toEqual({
      deep: ["astra", "sol"],
      standard: ["sol", "astra"],
      light: ["sol", "astra"],
    });
    const pinned: Catalog = { ...chosen, efforts: catalog.efforts, pinned: true };
    const costs = new CostBook([
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.2 },
      { provider: "codex", model: "sol", effort: "medium", quotaShare: 0.2 },
    ]);
    expect(
      run(
        route(spec({ kind: "docs" }), pinned, {
          routing: "balanced",
          usage: usage(0.8),
          costOf: costs.costOf("codex"),
        }),
      ),
    ).toMatchObject({ model: "sol" });
    expect(run(route(spec({ complexity: 5 }), pinned, { routing: "balanced" }))).toMatchObject({
      model: "astra",
    });
  });

  it("spreads: a provider that took most of the run yields to one with room", () => {
    const entry = (id: string): ProviderEntry => ({ id, catalog, usage: usage(0.1) });
    const assigned = new Map([
      ["claude-code", 3],
      ["codex", 0],
    ]);
    const routed = routeAcross(spec({ kind: "backend" }), [entry("claude-code"), entry("codex")], {
      auto: true,
      affinity: DEFAULT_AFFINITY,
      assigned,
      routing: "balanced",
    });
    expect(routed).toMatchObject({ kind: "run", provider: "codex" });
    expect(routed.kind === "run" && routed.reasons.join("\n")).toContain(
      "took most of this run's tasks",
    );
  });

  it("reads its mode from AGENT_ROUTING, balanced by default", () => {
    expect(routingMode(undefined)).toBe("balanced");
    expect(routingMode("Economy")).toBe("economy");
    expect(routingMode("bogus")).toBe("balanced");
  });
});

describe("what models spend", () => {
  it("measures an attempt's share of a window, its part of what the provider served meanwhile", () => {
    expect(attemptShare(0.4, 0.5, 1000, 1000)).toBeCloseTo(0.1);
    expect(attemptShare(0.4, 0.5, 1000, 4000)).toBeCloseTo(0.025);
    expect(attemptShare(0.9, 0.1, 1000, 1000)).toBeUndefined(); // the window reset
    expect(weightedTokens(100, 50, 1000)).toBe(250);
  });

  it("is kept across sessions in the metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-costs-"));
    try {
      const file = join(dir, "metrics.db");
      const metrics = new MetricsStore(file);
      metrics.close();
      // Opened again (a later session), with the column there.
      const again = new MetricsStore(file);
      expect(again.attempts()).toEqual([]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const book = new CostBook();
    book.add("codex", "astra", "high", 0.2);
    book.add("codex", "astra", "high", 0.1);
    expect(book.cost("codex", "astra", "high")).toEqual({ share: 0.15000000000000002, n: 2 });
    expect(book.entries()[0]).toMatchObject({ arm: "codex/astra · high", n: 2 });
  });
});

describe("each provider's models in Auto", () => {
  it("are a setting: chosen models per provider, auto when not named", () => {
    const env = { AGENT_AUTO_MODELS: "codex:gpt-6-astra, gpt-6.1-sol;claude-code:auto" };
    expect(autoModels(env)).toEqual({ codex: ["gpt-6-astra", "gpt-6.1-sol"] });
    expect(autoModelsSetting({ codex: ["a", "b"], "claude-code": [] })).toBe("codex:a,b");
  });
});
