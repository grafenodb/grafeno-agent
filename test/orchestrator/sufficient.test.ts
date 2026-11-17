import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import {
  classifyFailure,
  computeEvidence,
  judge,
  riskOf,
  roleOf,
  techOf,
} from "../../src/orchestrator/capability.js";
import { describeQuality, learningQuality } from "../../src/orchestrator/capability-report.js";
import { deriveRun, MetricsStore, type AttemptRecord } from "../../src/orchestrator/metrics.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import type { Catalog } from "../../src/orchestrator/router.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import {
  chooseSufficient,
  classOf,
  describeDecision,
  ladder,
  overBudget,
  TASK_SHARE_CAP,
  type PriorAttempt,
} from "../../src/orchestrator/sufficient.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";
import { compareRouters, POLICIES } from "../eval/routing-sim.js";

const catalog: Catalog = {
  models: [
    { id: "luna", name: "Luna" },
    { id: "terra", name: "Terra" },
    { id: "sol61", name: "Sol 6.1" },
    { id: "astra", name: "Astra 6" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: { deep: ["astra", "sol61"], standard: ["terra", "sol61"], light: ["luna", "terra"] },
};

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: "t",
  title: "T",
  description: "d",
  kind: "backend",
  dependsOn: [],
  complexity: 2,
  capabilities: ["code"],
  touches: ["src/a.ts"],
  acceptance: [{ check: "command", run: "npm test" }],
  parallelSafe: true,
  ...over,
});

let clock = 0;
/** Recorded attempts of one arm on one kind of task: `passed` of `n` judged, plus others. */
function attempts(
  model: string,
  effort: string,
  n: number,
  passed: number,
  over: Partial<AttemptRecord> = {},
): AttemptRecord[] {
  return Array.from({ length: n }, (_unused, i) => ({
    run: `r${String(clock)}`,
    task: `t${String(clock++)}`,
    attempt: 1,
    project: "p",
    at: new Date(clock * 1000).toISOString(),
    kind: "backend",
    complexity: 2,
    provider: "codex",
    model,
    effort,
    tier: classOf(model, catalog) ?? "standard",
    ms: 1000,
    rounds: 1,
    renewals: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    contextPeak: 0,
    window: 0,
    windowEstimated: true,
    outcome: "completed",
    explored: false,
    ...(i < passed
      ? { verified: true }
      : { verified: false, failure: "checks", fault: "model" as const }),
    ...over,
  }));
}

const choose = (
  task: TaskSpec,
  records: readonly AttemptRecord[] = [],
  extra: Partial<Parameters<typeof chooseSufficient>[2]> = {},
) => {
  const decision = chooseSufficient(task, catalog, {
    provider: "codex",
    mode: "balanced",
    evidence: computeEvidence(records),
    ...extra,
  });
  if (!decision) throw new Error("no decision");
  return decision;
};

describe("the ladder of a provider's arms", () => {
  it("orders models by the class their tiers give them, weakest first", () => {
    expect(classOf("sol61", catalog)).toBe("deep");
    expect(classOf("terra", catalog)).toBe("standard");
    expect(ladder(catalog).map((r) => `${r.model}·${r.effort ?? ""}`)).toEqual([
      "luna·low",
      "luna·medium",
      "luna·high",
      "terra·low",
      "terra·medium",
      "terra·high",
      "sol61·low",
      "sol61·medium",
      "sol61·high",
      "astra·low",
      "astra·medium",
      "astra·high",
    ]);
  });
});

describe("minimum sufficient model routing", () => {
  it("does not send simple tasks to strong models, whatever the planner recommends", () => {
    const docs = choose(spec({ kind: "docs", complexity: 1, touches: ["docs/guide.md"] }));
    expect(docs.tier).toBe("light");
    const simple = choose(spec({ recommended: { tier: "deep", effort: "high" } }));
    expect(simple.tier).not.toBe("deep");
    expect(simple.effort).not.toBe("high");
    expect(simple.confidence).toBe("prior");
    expect(simple.reason).toContain("is the cheapest sufficient arm for backend · low");
    // The strong arms are in the record, each with why it was left out.
    const astra = simple.candidates.find((c) => c.arm === "codex/astra · high");
    expect(astra).toMatchObject({ verdict: "discarded" });
    expect(astra?.why).toMatch(/expected cost|stronger arm than needed/);
  });

  it("still chooses a strong model when the task needs one", () => {
    const hard = choose(spec({ complexity: 5, kind: "debug", touches: ["src/auth/session.ts"] }));
    expect(hard.risk).toBe("high");
    expect(hard.tier).toBe("deep");
    const light = hard.candidates.find((c) => c.model === "luna");
    expect(light?.why).toMatch(/under the floor/);
  });

  it("learns from rates, not from how often a model was used", () => {
    // The strong arm ran 60 times and passed them all; the cheap one 12, all passed too:
    // popularity gives the strong arm nothing.
    const records = [...attempts("astra", "high", 60, 60), ...attempts("luna", "low", 12, 12)];
    const decision = choose(spec(), records);
    expect(decision).toMatchObject({ model: "luna", effort: "low" });
    expect(decision.confidence).toBe("evidence");
    expect(decision.reason).toMatch(/12 backend · low attempts \(\d+%–100% passed\)/);
    // And a cheap arm seen to fail often is left for one that passes.
    const failing = [...attempts("luna", "low", 12, 3), ...attempts("luna", "medium", 12, 3)];
    const moved = choose(spec(), [...failing, ...attempts("luna", "high", 12, 2)]);
    expect(moved.model).not.toBe("luna");
    expect(moved.candidates.find((c) => c.arm === "codex/luna · low")?.why).toMatch(
      /under the floor/,
    );
  });

  it("does not decide from too little evidence", () => {
    const before = choose(spec({ complexity: 3 }));
    // One failure does not rule an arm out; one lucky pass does not make a light model fit hard work.
    const oneFailure = choose(
      spec({ complexity: 3 }),
      attempts(before.model, before.effort ?? "", 1, 0, { complexity: 3 }),
    );
    expect(oneFailure.model).toBe(before.model);
    expect(oneFailure.tier).not.toBe("deep");
    const hard = spec({ complexity: 4 });
    const lucky = choose(hard, attempts("luna", "low", 1, 1, { complexity: 4 }));
    expect(lucky.model).not.toBe("luna");
  });

  it("does not hold the environment's failures against a model", () => {
    const clean = choose(spec());
    const blocked = attempts(clean.model, clean.effort ?? "", 30, 0, {
      outcome: "retry",
      failure: "error",
      fault: "environment",
    });
    const cells = computeEvidence(blocked);
    expect(cells[0]?.arms[0]).toMatchObject({ attempts: 0, environment: 30 });
    expect(choose(spec(), blocked).model).toBe(clean.model);
  });

  it("counts an older model version's attempts for half once a new one answers", () => {
    const old = attempts("terra", "medium", 10, 0, { modelVersion: "terra-2026-01" });
    const fresh = attempts("terra", "medium", 2, 2, { modelVersion: "terra-2026-09" });
    const arm = computeEvidence([...old, ...fresh])[0]?.arms[0];
    expect(arm).toMatchObject({ attempts: 12, weight: 7, weightedPassed: 2 });
    expect(arm?.versions).toEqual(["terra-2026-01", "terra-2026-09"]);
  });

  it("keeps deep models for what needs them when the plan is nearly spent", () => {
    const usage = { limits: [{ label: "5 hours", used: 0.8 }], at: new Date() };
    const medium = choose(spec({ complexity: 3 }), [], { usage });
    expect(medium.tier).not.toBe("deep");
    expect(medium.candidates.find((c) => c.tier === "deep")?.why).toMatch(/the plan is 80% used/);
    expect(choose(spec({ complexity: 5 }), [], { usage }).tier).toBe("deep");
  });

  it("says where each cost comes from: measured, estimated from what was measured, or unknown", () => {
    expect(choose(spec()).costSource).toBe("unknown");
    const measured = attempts("luna", "medium", 4, 4, { quotaShare: 0.004 });
    const decision = choose(spec(), measured);
    const byArm = (arm: string) => decision.candidates.find((c) => c.arm === arm);
    expect(byArm("codex/luna · medium")).toMatchObject({ costSource: "observed", cost: 0.004 });
    expect(byArm("codex/astra · high")?.costSource).toBe("estimated");
    expect(byArm("codex/astra · high")?.cost).toBeGreaterThan(0.004 * 8);
  });
});

describe("escalation", () => {
  const failed = (model: string, effort: string, failure = "checks"): PriorAttempt => ({
    model,
    effort,
    verdict: "failed",
    failure,
  });

  it("retries the same arm once with the checks' diagnostic, then goes up", () => {
    const first = choose(spec({ complexity: 3 }));
    const arm = { model: first.model, effort: first.effort ?? "" };
    const second = choose(spec({ complexity: 3 }), [], {
      history: [failed(arm.model, arm.effort)],
    });
    expect(second).toMatchObject({ model: arm.model, effort: arm.effort });
    expect(second.escalation).toMatch(/retrying .* once with the checks' diagnostic/);
    const third = choose(spec({ complexity: 3 }), [], {
      history: [failed(arm.model, arm.effort), failed(arm.model, arm.effort)],
    });
    expect(third.escalation).toMatch(/failed \(checks, 2 times\): escalating/);
    const rungs = ladder(catalog).map((r) => `${r.model}·${r.effort ?? ""}`);
    expect(rungs.indexOf(`${third.model}·${third.effort ?? ""}`)).toBeGreaterThan(
      rungs.indexOf(`${arm.model}·${arm.effort}`),
    );
    // The last attempt goes to what is most likely to pass.
    expect(third.tier).toBe("deep");
  });

  it("goes up at once when the failure shows the model was not enough", () => {
    const first = choose(spec({ complexity: 3 }));
    const next = choose(spec({ complexity: 3 }), [], {
      history: [failed(first.model, first.effort ?? "", "agent")],
    });
    expect(next.escalation).toMatch(/failed \(agent\): escalating/);
    expect(`${next.model}·${next.effort ?? ""}`).not.toBe(`${first.model}·${first.effort ?? ""}`);
  });

  it("does not escalate for the environment's failures, and never without end", () => {
    const first = choose(spec());
    const again = choose(spec(), [], {
      history: [{ model: first.model, effort: first.effort ?? "", verdict: "environment" }],
    });
    expect(again).toMatchObject({ model: first.model });
    expect(again.escalation).toBeUndefined();
    // The top of the ladder is tried again, not passed.
    const top = choose(spec({ complexity: 5 }), [], {
      history: [failed("astra", "high", "agent")],
    });
    expect(top).toMatchObject({ model: "astra", effort: "high" });
    // A task that spent its share of the plan stops.
    expect(overBudget([{ model: "astra", verdict: "failed", share: TASK_SHARE_CAP }])).toMatch(
      /already took 25% of a plan's window/,
    );
    expect(overBudget([{ model: "luna", verdict: "failed", share: 0.01 }])).toBeUndefined();
  });
});

describe("whose fault a failure was, by code", () => {
  it("blames the model only for what it could have done better", () => {
    expect(classifyFailure("checks", "- `npm test` exited 1: 2 tests failed")).toBe("model");
    expect(classifyFailure("agent", "stopped at the step limit")).toBe("model");
    expect(classifyFailure("usage_limit", "the plan's limit")).toBe("environment");
    expect(classifyFailure(undefined, "The user did not allow multi_edit to run.")).toBe(
      "environment",
    );
    expect(classifyFailure("checks", "ModuleNotFoundError: No module named 'httpx'")).toBe(
      "environment",
    );
    expect(classifyFailure(undefined, "merging into grafeno/x/integration conflicts in a.ts")).toBe(
      "environment",
    );
    expect(classifyFailure(undefined, "the reviewer (codex) still asks for changes")).toBe(
      "ambiguous",
    );
    expect(judge({ outcome: "quota" })).toBe("environment");
    expect(judge({ outcome: "completed", verified: false })).toBe("failed");
    // Records made before faults were kept are judged by their outcome.
    expect(judge({ outcome: "completed" })).toBe("passed");
    expect(judge({ outcome: "retry", failure: "usage_limit" })).toBe("environment");
  });

  it("tells a task's risk, technology and role from what it is", () => {
    expect(riskOf(spec({ touches: ["db/migrations/004.sql"] }))).toBe("high");
    expect(riskOf(spec({ kind: "docs", touches: ["docs/a.md"] }))).toBe("low");
    expect(riskOf(spec())).toBe("normal");
    expect(techOf(["python/src/a.py", "python/tests/b.py", "README.md"])).toBe("python");
    expect(techOf([])).toBe("unknown");
    expect(roleOf("architecture")).toBe("planning");
    expect(roleOf("debug")).toBe("debugging");
    expect(roleOf("backend")).toBe("implementation");
  });
});

describe("what a run records of each attempt", () => {
  it("reads each attempt's checks, fault and questions from the run's events", () => {
    const store = new SqliteStore();
    const plan: Plan = { goal: "g", risks: [], tasks: [spec({ id: "api" })] };
    const run = store.createRun("g", plan, ["api"]);
    const metrics = (attempt: number, outcome: string, extra: Record<string, unknown> = {}) => {
      store.event(run.id, "attempt_started", { attempt }, "api");
      store.event(
        run.id,
        "attempt_metrics",
        {
          attempt,
          model: "codex/luna",
          provider: "codex",
          modelId: "luna",
          tier: "light",
          outcome,
          ...extra,
        },
        "api",
      );
    };
    // 1: its checks failed. 2: a person refused a command. 3: escalated, verified.
    metrics(1, "completed", { effort: "medium" });
    store.event(run.id, "verified", { ok: false }, "api");
    store.event(
      run.id,
      "attempt_ended",
      { attempt: 1, status: "retry", reason: "- `npm test` exited 1" },
      "api",
    );
    metrics(2, "retry", { failure: "agent" });
    store.event(run.id, "question", { action: "run x", answer: false }, "api");
    store.event(
      run.id,
      "attempt_ended",
      { attempt: 2, status: "retry", reason: "The user did not allow run_command to run." },
      "api",
    );
    metrics(3, "completed", { escalatedFrom: "luna · medium", modelVersion: "terra-2026-09" });
    store.event(run.id, "verified", { ok: true }, "api");
    const { attempts: recorded } = deriveRun(store, run.id, "p");
    expect(recorded.map((a) => [a.attempt, judge(a), a.fault, a.failure])).toEqual([
      [1, "failed", "model", "checks"],
      [2, "environment", "environment", "agent"],
      [3, "passed", undefined, undefined],
    ]);
    expect(recorded[1]?.human).toBe(1);
    expect(recorded[2]).toMatchObject({
      escalatedFrom: "luna · medium",
      modelVersion: "terra-2026-09",
      risk: "normal",
      tech: "typescript",
    });
  });

  it("holds neither a broken check nor a timeout with no answer against the model", () => {
    const store = new SqliteStore();
    const plan: Plan = { goal: "g", risks: [], tasks: [spec({ id: "api" })] };
    const run = store.createRun("g", plan, ["api"]);
    const metrics = (attempt: number, outcome: string, extra: Record<string, unknown> = {}) => {
      store.event(run.id, "attempt_started", { attempt }, "api");
      store.event(
        run.id,
        "attempt_metrics",
        {
          attempt,
          model: "lmstudio/gemma",
          provider: "lmstudio",
          modelId: "gemma",
          outcome,
          ...extra,
        },
        "api",
      );
    };
    // 1: the check's own command was broken. 2: no answer came back at all. 3: a slow, real one.
    metrics(1, "completed", { inputTokens: 900, outputTokens: 80 });
    store.event(run.id, "verified", { ok: false }, "api");
    store.event(
      run.id,
      "attempt_ended",
      {
        attempt: 1,
        status: "retry",
        reason:
          "These checks failed; fix the work so that they pass:\n- `wc -c < greeting.txt | awk '{print $1}' == 5` exited 2:\nawk: fatal: cannot open file `==' for reading: No such file or directory",
      },
      "api",
    );
    metrics(2, "retry", { failure: "timeout", inputTokens: 0, outputTokens: 0 });
    store.event(
      run.id,
      "attempt_ended",
      { attempt: 2, status: "retry", reason: "timeout: The turn took longer than 600000 ms" },
      "api",
    );
    metrics(3, "retry", { failure: "timeout", inputTokens: 5000, outputTokens: 900 });
    store.event(
      run.id,
      "attempt_ended",
      { attempt: 3, status: "retry", reason: "timeout: The turn took longer than 600000 ms" },
      "api",
    );
    const { attempts: recorded } = deriveRun(store, run.id, "p");
    expect(recorded.map((a) => [a.attempt, judge(a), a.failureClass])).toEqual([
      [1, "ambiguous", "ambiguous"],
      [2, "ambiguous", "infrastructure"],
      [3, "failed", "context"],
    ]);
  });

  it("opens a metrics file made before these columns, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-metrics-"));
    try {
      const file = join(dir, "metrics.db");
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE attempts (
        run TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
        project TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, complexity INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, tier TEXT NOT NULL,
        ms INTEGER NOT NULL, rounds INTEGER NOT NULL, renewals INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL,
        context_peak INTEGER NOT NULL, window INTEGER NOT NULL, window_estimated INTEGER NOT NULL,
        quota_used REAL, outcome TEXT NOT NULL, failure TEXT, explored INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run, task, attempt));
      CREATE TABLE outcomes (
        run TEXT NOT NULL, task TEXT NOT NULL, project TEXT NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, complexity INTEGER NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL, checks_failed INTEGER NOT NULL,
        merged INTEGER NOT NULL, conflict INTEGER NOT NULL, review TEXT, PRIMARY KEY (run, task));
      INSERT INTO attempts VALUES ('r','t',1,'p','2026-11-01T00:00:00Z','backend',2,'codex','astra','high','deep',1,1,0,1,1,0,1,1,0,NULL,'completed',NULL,0);`);
      old.close();
      const metrics = new MetricsStore(file);
      const [row] = metrics.attempts();
      expect(row).toMatchObject({ model: "astra", outcome: "completed" });
      expect(row?.verified).toBeUndefined();
      expect(judge(row as AttemptRecord)).toBe("passed");
      metrics.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the router in a worker pool", () => {
  const provider: Provider = {
    id: "codex",
    name: "Codex",
    signIn: "",
    tiers: catalog.tiers,
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
    models: () => Promise.resolve(catalog.models),
    efforts: () => catalog.efforts,
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () => new FakeModel({ turns: [] }),
  };
  const pool = (over: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) =>
    new WorkerPool({
      provider,
      workspaceFor: () => Promise.resolve(new Workspace(".")),
      tools: () => [],
      routing: "balanced",
      sufficient: { mode: "learned", attempts: () => [] },
      ...over,
    });
  const task = spec({ complexity: 3, recommended: { tier: "deep", effort: "high" } });

  it("uses the minimum sufficient arm, and keeps what the rules would have chosen", async () => {
    const route = await pool().routeFor(task);
    expect(route.kind === "run" && route.tier).not.toBe("deep");
    expect(route.kind === "run" && route.decision?.rule).toBe("codex/terra · medium");
    expect(route.kind === "run" && route.reasons.at(-1)).toContain("cheapest sufficient arm");
  });

  it("in shadow, records the decision and keeps the rules' choice", async () => {
    const shadow = await pool({ sufficient: { mode: "shadow", attempts: () => [] } }).routeFor(
      spec({ kind: "docs", complexity: 1 }),
    );
    expect(shadow).toMatchObject({ kind: "run", model: "luna", effort: "low" });
    expect(shadow.kind === "run" && shadow.decision).toBeDefined();
  });

  it("leaves quality, the fixed rules and the models a person chose as they were", async () => {
    const quality = await pool({ routing: "quality" }).routeFor(task);
    expect(quality).toMatchObject({ kind: "run", model: "astra", effort: "high" });
    expect(quality.kind === "run" && quality.decision).toBeUndefined();
    // The fixed rules alone (AGENT_ROUTER=rules): no decision is made at all.
    const rules = await pool({ sufficient: undefined as never }).routeFor(task);
    expect(rules.kind === "run" && rules.decision).toBeUndefined();
    const pinned = await pool({ auto: true, models: { codex: ["astra"] } }).routeFor(task);
    expect(pinned).toMatchObject({ kind: "run", model: "astra" });
    expect(pinned.kind === "run" && pinned.decision).toBeUndefined();
  });
});

describe("how well the router knows its models", () => {
  it("warns when deep models take the work that is not hard, and when nothing cheaper was tried", () => {
    const records = attempts("astra", "high", 20, 20);
    const quality = learningQuality(records);
    expect(quality).toMatchObject({ easyAttempts: 20, easyOnDeep: 20 });
    expect(describeQuality(quality).join("\n")).toMatch(
      /100% of the attempts on tasks of low or medium complexity ran on deep models/,
    );
    expect(quality.warnings.join("\n")).toContain("only codex/astra · high was ever tried");
    expect(learningQuality(attempts("luna", "low", 20, 19)).warnings).toHaveLength(1);
  });

  it("explains a decision line by line", () => {
    const lines = describeDecision(choose(spec()));
    expect(lines[0]).toMatch(/^backend · low · risk normal · balanced: /);
    expect(lines.some((l) => l.includes("▸"))).toBe(true);
    expect(lines.some((l) => l.includes("codex/astra · high"))).toBe(true);
  });
});

describe("the old router and the new, on the same fixed tasks (simulated)", () => {
  it("spends less, keeps deep models for hard tasks, and does not lose success", () => {
    const [quality, balanced, sufficient, economy] = compareRouters(
      300,
      [11, 23, 37],
      POLICIES.slice(0, 4),
    );
    if (!quality || !balanced || !sufficient || !economy) throw new Error("no results");
    // Simple work no longer goes to deep models; hard work still does.
    expect(quality.deepEasy).toBeGreaterThan(0.3);
    expect(sufficient.deepEasy).toBeLessThan(0.05);
    expect(sufficient.deepHard).toBeGreaterThan(0.5);
    // Less of the plans is spent than by either set of rules.
    expect(sufficient.quota).toBeLessThan(balanced.quota * 0.85);
    expect(sufficient.quota).toBeLessThan(quality.quota * 0.5);
    // Success is not degraded: within 1.5 points of the better of the rules.
    expect(sufficient.success).toBeGreaterThan(Math.max(quality.success, balanced.success) - 0.015);
    expect(economy.success).toBeGreaterThan(0.93);
    // The environment's failures were never held against a model.
    expect(sufficient.unfairlyBlamed).toBe(0);
  });
});

describe("escalation in a run", { timeout: 60_000 }, () => {
  it("starts on the cheapest sufficient arm, retries it once, then escalates, and records why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-escalate-"));
    const plan: Plan = {
      goal: "Write the api",
      risks: [],
      tasks: [
        spec({ id: "api", complexity: 3, acceptance: [{ check: "files", exist: ["api.txt"] }] }),
      ],
    };
    // Only the deep models are able to do this task: the others say done without doing it.
    const provider: Provider = {
      id: "codex",
      name: "Codex",
      signIn: "",
      tiers: catalog.tiers,
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
      models: () => Promise.resolve(catalog.models),
      efforts: () => catalog.efforts,
      usage: () => Promise.resolve(undefined),
      modelName: (m) => m,
      create: (choice) =>
        new FakeModel({
          turns: [
            (context) =>
              context.system.includes("You are the planner")
                ? [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }]
                : classOf(choice.model ?? "", catalog) === "deep"
                  ? [
                      { call: "write_file", input: { path: "api.txt", content: "api\n" } },
                      { say: "Done." },
                    ]
                  : [{ say: "Done." }],
          ],
        }),
    };
    const metrics = new MetricsStore(":memory:");
    const orchestrator = new Orchestrator({
      provider,
      project: { name: "shop", path: dir },
      projectRoot: dir,
      dataDir: join(dir, "data"),
      metrics,
      mode: "extended",
      routing: "balanced",
      delivery: "manual",
    });
    try {
      const planned = await orchestrator.plan("Write the api");
      const { run } = await orchestrator.start("Write the api", planned);
      expect(await orchestrator.run(run.id)).toBe("completed");
      const decisions = orchestrator.decisions(run.id).filter((d) => d.task === "api");
      expect(decisions).toHaveLength(3);
      const arm = (i: number) =>
        `${decisions[i]?.decision.model ?? ""}·${decisions[i]?.decision.effort ?? ""}`;
      expect(decisions[0]?.decision.tier).not.toBe("deep");
      expect(arm(1)).toBe(arm(0));
      expect(decisions[1]?.decision.escalation).toMatch(
        /retrying .* once with the checks' diagnostic/,
      );
      expect(decisions[2]?.decision.tier).toBe("deep");
      expect(decisions[2]?.decision.escalation).toMatch(/2 times\): escalating/);
      // What the run teaches: two failures of the cheap arm, the model's own, and an escalation that passed.
      const recorded = metrics.attempts().filter((a) => a.task === "api");
      expect(recorded.map((a) => judge(a))).toEqual(["failed", "failed", "passed"]);
      expect(recorded[0]).toMatchObject({ fault: "model", failure: "checks" });
      expect(recorded[2]?.escalatedFrom).toBe(arm(0).replace("·", " · "));
    } finally {
      orchestrator.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("a hot downgrade", { timeout: 60_000 }, () => {
  it("moves an attempt that spends too much of the plan to a lighter model, keeping its work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-downgrade-"));
    const plan: Plan = {
      goal: "Write the api",
      risks: [],
      tasks: [
        spec({ id: "api", complexity: 4, acceptance: [{ check: "files", exist: ["api.txt"] }] }),
      ],
    };
    let used = 0.1;
    const models: string[] = [];
    const provider: Provider = {
      id: "codex",
      name: "Codex",
      signIn: "",
      tiers: catalog.tiers,
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
      models: () => Promise.resolve(catalog.models),
      efforts: () => catalog.efforts,
      // Every reading finds the window fuller: the attempt is spending a lot.
      usage: () => {
        used += 0.1;
        return Promise.resolve({ limits: [{ label: "5 hours", used }], at: new Date() });
      },
      modelName: (m) => m,
      create: (choice) => {
        models.push(`${choice.model ?? ""}·${choice.effort ?? ""}`);
        return new FakeModel({
          turns: [
            (context) => {
              if (context.system.includes("You are the planner")) {
                return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
              }
              // A renewed session finishes; the first one works past its round of steps.
              if (context.message.includes("Continue the task from here")) {
                return [
                  { call: "write_file", input: { path: "api.txt", content: "api\n" } },
                  { say: "Done." },
                ];
              }
              if (/renewed to free context/.test(context.message)) {
                return [{ say: "Read the code; the API is next." }];
              }
              return [
                { call: "list_files", input: {} },
                { say: "looking" },
                { call: "list_files", input: {} },
                { say: "still looking" },
                { call: "list_files", input: {} },
              ];
            },
          ],
        });
      },
    };
    const orchestrator = new Orchestrator({
      provider,
      project: { name: "shop", path: dir },
      projectRoot: dir,
      dataDir: join(dir, "data"),
      metrics: false,
      mode: "extended",
      routing: "balanced",
      delivery: "manual",
      context: { roundSteps: 2 },
    });
    try {
      const planned = await orchestrator.plan("Write the api");
      const { run } = await orchestrator.start("Write the api", planned);
      const state = await orchestrator.run(run.id);
      expect(state).toBe("completed");
      const downgraded = orchestrator.store.events(run.id).filter((e) => e.kind === "downgraded");
      expect(downgraded).toHaveLength(1);
      const from = String(downgraded[0]?.data.from);
      const to = String(downgraded[0]?.data.to);
      const order = ["light", "standard", "deep"];
      const classOfArm = (arm: string) =>
        order.indexOf(classOf(arm.split(" · ")[0] ?? "", catalog) ?? "");
      expect(classOfArm(to)).toBeLessThan(classOfArm(from));
      expect(Number(downgraded[0]?.data.share)).toBeGreaterThanOrEqual(0.08);
      // The lighter model took over in the same attempt, from the progress so far.
      expect(models.at(-1)).toBe(to.replace(" · ", "·"));
    } finally {
      orchestrator.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
