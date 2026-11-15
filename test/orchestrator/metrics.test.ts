import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRuns, MetricsStore, splitModel } from "../../src/orchestrator/metrics.js";
import type { Plan } from "../../src/orchestrator/plan.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { failureOf } from "../../src/orchestrator/workers.js";
import { ModelError } from "../../src/model/index.js";

const plan: Plan = {
  goal: "Build it",
  risks: [],
  tasks: [
    { id: "api", kind: "backend" as const, complexity: 3 },
    { id: "docs", kind: "docs" as const, complexity: 1 },
    { id: "ui", kind: "frontend" as const, complexity: 2 },
  ].map((t) => ({
    ...t,
    title: t.id,
    description: t.id,
    dependsOn: [],
    capabilities: ["code"],
    touches: [`src/${t.id}.ts`],
    acceptance: [{ check: "command" as const, run: "npm test" }],
    parallelSafe: true,
  })),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-metrics-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold the file a moment longer.
  }
});

/** A run as the orchestrator leaves it: attempts, checks, merges, a review. */
function recordedRun(store: SqliteStore): string {
  const run = store.createRun("Build it", plan, ["api", "docs", "ui"]);
  const go = (task: string) => {
    store.transition(run.id, task, "ready");
    store.transition(run.id, task, "running", { attempts: 1 });
  };
  // api: a check failed and was fixed; then merged. A phase C attempt record.
  go("api");
  store.event(
    run.id,
    "attempt_metrics",
    {
      task: "api",
      kind: "backend",
      complexity: 3,
      model: "claude-code/sonnet",
      provider: "claude-code",
      modelId: "sonnet",
      attempt: 1,
      effort: "medium",
      tier: "standard",
      ms: 4000,
      rounds: 2,
      renewals: 0,
      inputTokens: 1200,
      outputTokens: 300,
      cacheTokens: 5000,
      contextPeak: 9000,
      window: 200_000,
      windowEstimated: false,
      quotaUsed: 0.42,
      outcome: "completed",
    },
    "api",
  );
  store.event(run.id, "verified", { ok: false }, "api");
  store.event(run.id, "verified", { ok: true }, "api");
  store.event(run.id, "merged", { commit: "abc" }, "api");
  store.transition(run.id, "api", "completed");
  // docs: an attempt recorded before phase C (one provider, no number), merged.
  go("docs");
  store.event(
    run.id,
    "attempt_metrics",
    {
      task: "docs",
      kind: "docs",
      complexity: 1,
      model: "haiku",
      effort: "low",
      tier: "light",
      ms: 1500,
      rounds: 1,
      renewals: 0,
      inputTokens: 400,
      outputTokens: 90,
      cacheTokens: 2000,
      contextPeak: 3000,
      window: 200_000,
      windowEstimated: true,
      outcome: "completed",
    },
    "docs",
  );
  store.event(run.id, "verified", { ok: true }, "docs");
  store.event(run.id, "merged", { commit: "def" }, "docs");
  store.transition(run.id, "docs", "completed");
  // ui: a provider limit and a conflict; a person rejected it in review.
  go("ui");
  store.event(
    run.id,
    "attempt_metrics",
    {
      task: "ui",
      kind: "frontend",
      complexity: 2,
      model: "codex/gpt-6-luna",
      provider: "codex",
      modelId: "gpt-6-luna",
      attempt: 1,
      tier: "light",
      ms: 800,
      rounds: 1,
      renewals: 0,
      inputTokens: 100,
      outputTokens: 10,
      cacheTokens: 0,
      contextPeak: 500,
      window: 200_000,
      windowEstimated: true,
      outcome: "review",
      failure: "usage_limit",
    },
    "ui",
  );
  store.event(run.id, "conflict", { files: ["src/ui.ts"] }, "ui");
  store.transition(run.id, "ui", "review", { reason: "a conflict" });
  store.transition(run.id, "ui", "failed", { reason: "rejected" });
  return run.id;
}

describe("splitModel", () => {
  it("separates the provider from the model, whichever way the label was written", () => {
    expect(splitModel("codex/gpt-6-luna")).toEqual({ provider: "codex", model: "gpt-6-luna" });
    expect(splitModel("haiku")).toEqual({ provider: "claude-code", model: "haiku" });
    expect(splitModel("mid", "other")).toEqual({ provider: "other", model: "mid" });
  });
});

describe("MetricsStore", () => {
  it("records each attempt and each task's outcome from a run's events, with every field of §C.1", () => {
    const store = new SqliteStore(join(dir, "shop.db"));
    const runId = recordedRun(store);
    const metrics = new MetricsStore(join(dir, "metrics.db"));
    metrics.recordRun(store, runId, "shop");

    const attempts = metrics.attempts();
    expect(attempts).toHaveLength(3);
    expect(attempts.find((a) => a.task === "api")).toMatchObject({
      project: "shop",
      kind: "backend",
      complexity: 3,
      provider: "claude-code",
      model: "sonnet",
      effort: "medium",
      tier: "standard",
      attempt: 1,
      ms: 4000,
      rounds: 2,
      inputTokens: 1200,
      outputTokens: 300,
      quotaUsed: 0.42,
      outcome: "completed",
      explored: false,
    });
    // An attempt recorded before phase C: split label, numbered in order, no quota.
    const docs = attempts.find((a) => a.task === "docs");
    expect(docs).toMatchObject({ provider: "claude-code", model: "haiku", attempt: 1 });
    expect(docs?.quotaUsed).toBeUndefined();
    expect(attempts.find((a) => a.task === "ui")).toMatchObject({
      provider: "codex",
      failure: "usage_limit",
    });

    const outcomes = metrics.outcomes();
    expect(outcomes.find((o) => o.task === "api")).toMatchObject({
      state: "completed",
      checksFailed: 1,
      merged: true,
      conflict: false,
    });
    expect(outcomes.find((o) => o.task === "api")?.review).toBeUndefined();
    expect(outcomes.find((o) => o.task === "ui")).toMatchObject({
      state: "failed",
      conflict: true,
      merged: false,
      review: "rejected",
    });
    metrics.close();
    store.close();
  });

  it("counts nothing twice when a run is recorded again, and leaves out tasks not yet ended", () => {
    const store = new SqliteStore(join(dir, "shop.db"));
    const runId = recordedRun(store);
    const open = store.createRun("Later", plan, ["api", "docs", "ui"]);
    store.transition(open.id, "api", "ready");
    const metrics = new MetricsStore(join(dir, "metrics.db"));
    metrics.recordRun(store, runId, "shop");
    metrics.recordRun(store, runId, "shop");
    metrics.recordRun(store, open.id, "shop");
    expect(metrics.attempts()).toHaveLength(3);
    expect(metrics.outcomes()).toHaveLength(3);
    metrics.close();
    store.close();
  });

  it("keeps no text: only numbers, ids and categories", () => {
    const store = new SqliteStore(join(dir, "shop.db"));
    const runId = recordedRun(store);
    store.event(runId, "attempt_metrics", { task: "x", reason: "SECRET-TEXT gk_abc123" }, "api");
    const metrics = new MetricsStore(join(dir, "metrics.db"));
    metrics.recordRun(store, runId, "shop");
    expect(JSON.stringify(metrics.attempts())).not.toContain("SECRET-TEXT");
    expect(JSON.stringify(metrics.outcomes())).not.toContain("rejected because");
    metrics.close();
    store.close();
  });

  it("imports the runs already kept in the data folder, once", () => {
    mkdirSync(join(dir, "runs"));
    const store = new SqliteStore(join(dir, "runs", "shop.db"));
    recordedRun(store);
    store.close();
    const metrics = new MetricsStore(join(dir, "metrics.db"));
    expect(importRuns(dir, metrics)).toBe(1);
    expect(importRuns(dir, metrics)).toBe(1);
    expect(metrics.attempts()).toHaveLength(3);
    expect(new Set(metrics.attempts().map((a) => a.project))).toEqual(new Set(["shop"]));
    expect(importRuns(join(dir, "nowhere"), metrics)).toBe(0);
    metrics.close();
  });
});

describe("failureOf", () => {
  it("gives a category, never the message", () => {
    expect(failureOf(new ModelError("usage_limit", "limit at 3pm for you@example.com"))).toBe(
      "usage_limit",
    );
    expect(failureOf(new Error("Timed out after 600 s"))).toBe("timeout");
    expect(failureOf(new Error("something private"))).toBe("error");
  });
});

describe("explored attempts", () => {
  it("are recorded as such, so the router can tell them apart", () => {
    const store = new SqliteStore(join(dir, "shop.db"));
    const run = store.createRun("Build it", plan, ["api", "docs", "ui"]);
    store.event(
      run.id,
      "attempt_metrics",
      {
        task: "docs",
        kind: "docs",
        complexity: 1,
        model: "p/small",
        attempt: 1,
        outcome: "completed",
        explored: true,
      },
      "docs",
    );
    const metrics = new MetricsStore(join(dir, "metrics.db"));
    metrics.recordRun(store, run.id, "shop");
    expect(metrics.attempts()[0]).toMatchObject({ provider: "p", model: "small", explored: true });
    metrics.close();
    store.close();
  });
});
