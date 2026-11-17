import { describe, expect, it } from "vitest";
import {
  brokenCheck,
  classifyFailure,
  computeEvidence,
  failureClass,
} from "../../src/orchestrator/capability.js";
import type { AttemptRecord } from "../../src/orchestrator/metrics.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import type { Catalog } from "../../src/orchestrator/router.js";
import {
  chooseSufficient,
  evidenceState,
  type PriorAttempt,
  type SufficientOptions,
} from "../../src/orchestrator/sufficient.js";

const catalog: Catalog = {
  models: [
    { id: "small", name: "Small" },
    { id: "mid", name: "Mid" },
    { id: "big", name: "Big" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: { deep: ["big"], standard: ["mid"], light: ["small"] },
};

function task(extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t",
    title: "T",
    description: "",
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: ["src/a.ts"],
    acceptance: [{ check: "command", run: "npm test" }],
    parallelSafe: true,
    ...extra,
  };
}

const docs = (extra: Partial<TaskSpec> = {}) =>
  task({ kind: "docs", touches: ["docs/guide.md"], complexity: 1, ...extra });

function record(
  model: string,
  effort: string,
  passed: boolean,
  extra: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    run: "r",
    task: "x",
    attempt: 1,
    project: "p",
    at: new Date().toISOString(),
    kind: "backend",
    complexity: 2,
    provider: "p",
    model,
    effort,
    tier: "light",
    ms: 1000,
    rounds: 1,
    renewals: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    contextPeak: 0,
    window: 0,
    windowEstimated: true,
    outcome: passed ? "completed" : "retry",
    explored: false,
    ...(passed
      ? { verified: true }
      : { verified: false, failure: "checks", fault: "model" as const }),
    ...extra,
  };
}

const base = (extra: Partial<SufficientOptions> = {}): SufficientOptions => ({
  provider: "p",
  mode: "balanced",
  evidence: [],
  ...extra,
});

/** A seeded generator: the same seed, the same choices. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("cold start", () => {
  it("with no history, a simple task starts on a light model; no evidence is 'unknown', never a failure", () => {
    const decision = chooseSufficient(task({ complexity: 2 }), catalog, base());
    expect(decision?.tier).toBe("light");
    expect(decision?.state).toBe("unknown");
    expect(decision?.confidence).toBe("prior");
    expect(decision?.reason).toContain("the prior for a light model");
    // Every arm is unknown: the priors are assumptions, said as such.
    expect(decision?.candidates.every((c) => c.state === "unknown")).toBe(true);
    const under = decision?.candidates.find((c) => c.p < decision.floor);
    if (under) expect(under.why).toContain("an assumption, not a failure");
  });

  it("a stronger model never wins by its higher prior alone: only by what the task needs", () => {
    const easy = chooseSufficient(task({ complexity: 1 }), catalog, base());
    expect(easy?.tier).not.toBe("deep");
    const big = easy?.candidates.find((c) => c.model === "big" && c.effort === "high");
    expect(big?.p).toBeGreaterThan(easy?.candidates.find((c) => c.verdict === "selected")?.p ?? 1);
    expect(big?.verdict).toBe("discarded");
  });

  it("critical work is not downgraded: high risk or the hardest band start stronger", () => {
    const risky = chooseSufficient(
      task({ complexity: 3, touches: ["src/auth/session.ts"] }),
      catalog,
      base(),
    );
    expect(risky?.risk).toBe("high");
    expect(risky?.tier).not.toBe("light");
    const hard = chooseSufficient(task({ complexity: 5 }), catalog, base());
    expect(hard?.tier).toBe("deep");
  });

  it("is the same for the same inputs (deterministic without exploration)", () => {
    const a = chooseSufficient(task(), catalog, base());
    const b = chooseSufficient(task(), catalog, base());
    expect(a).toEqual(b);
  });

  it("names how much is known of each arm", () => {
    expect(evidenceState(0, 1, 0.6)).toBe("unknown");
    expect(evidenceState(2, 1, 0.6)).toBe("exploring");
    expect(evidenceState(6, 0.9, 0.6)).toBe("provisional");
    expect(evidenceState(12, 0.9, 0.6)).toBe("established");
    expect(evidenceState(8, 0.5, 0.6)).toBe("degraded");
  });
});

describe("the leader's recommendation", () => {
  it("is not followed when a cheaper arm is sufficient, and why is recorded", () => {
    const decision = chooseSufficient(
      task({ complexity: 1 }),
      catalog,
      base({ advice: { model: "big" } }),
    );
    expect(decision?.model).not.toBe("big");
    expect(decision?.advice).toMatchObject({ arm: "p/big", followed: false });
    expect(decision?.advice?.why).toMatch(/expected cost .* against/);
  });

  it("is followed when it is the cheapest sufficient arm too, or within a small margin", () => {
    const same = chooseSufficient(
      task({ complexity: 2 }),
      catalog,
      base({ advice: { model: "small" } }),
    );
    expect(same?.model).toBe("small");
    expect(same?.advice).toMatchObject({
      followed: true,
      why: "it is the cheapest sufficient arm too",
    });
  });

  it("is refused when it cannot do the task, whatever it is", () => {
    const hard = chooseSufficient(
      task({ complexity: 5 }),
      catalog,
      base({ advice: { model: "small" } }),
    );
    expect(hard?.model).toBe("big");
    expect(hard?.advice?.followed).toBe(false);
    expect(hard?.advice?.why).toMatch(/not sufficient for this task/);
    expect(
      chooseSufficient(task(), catalog, base({ advice: { model: "nope" } }))?.advice?.why,
    ).toBe("this provider has no such model");
  });
});

describe("exploration", () => {
  // Evidence that keeps the light arm on easy docs (unknown everywhere else).
  const explore = (share: number, budgetLeft = true, seed = 1) => ({
    share,
    random: seeded(seed),
    budgetLeft,
  });

  it("tries a cheaper arm little is known of, on a low-risk task, and says so", () => {
    // The cheapest arm failed 3 times on such docs: too few to settle anything (still
    // "exploring"), but enough to put it under the floor, so it would never be tried again.
    const evidence = computeEvidence(
      Array.from({ length: 3 }, () =>
        record("small", "low", false, { kind: "docs", complexity: 1 }),
      ),
    );
    const plain = chooseSufficient(docs(), catalog, base({ evidence }));
    expect([plain?.model, plain?.effort]).toEqual(["small", "medium"]);
    expect(plain?.explored).toBeUndefined();
    const lowArm = plain?.candidates.find((c) => c.model === "small" && c.effort === "low");
    expect(lowArm?.state).toBe("exploring");
    const tried = chooseSufficient(docs(), catalog, base({ evidence, explore: explore(1) }));
    expect([tried?.model, tried?.effort]).toEqual(["small", "low"]);
    expect(tried?.explored).toEqual({ instead: "p/small · medium", probability: 1 });
    expect(tried?.state).toBe("exploring");
    expect(tried?.reason).toMatch(/^explored p\/small · low/);
    // Never explored: the chance did not come up.
    const missed = chooseSufficient(
      docs(),
      catalog,
      base({ evidence, explore: explore(0.000001) }),
    );
    expect(missed?.explored).toBeUndefined();
  });

  it("never on a task that is not low-risk, after a failure, or with the budget spent", () => {
    const normal = chooseSufficient(task(), catalog, base({ explore: explore(1) }));
    expect(normal?.explored).toBeUndefined();
    const spent = chooseSufficient(docs(), catalog, base({ explore: explore(1, false) }));
    expect(spent?.explored).toBeUndefined();
    const failed: PriorAttempt[] = [
      { model: "small", effort: "low", verdict: "failed", failure: "checks" },
    ];
    const retry = chooseSufficient(docs(), catalog, base({ explore: explore(1), history: failed }));
    expect(retry?.explored).toBeUndefined();
  });

  it("is reproducible with the same seed", () => {
    const run = (seed: number) =>
      Array.from(
        { length: 20 },
        () => chooseSufficient(docs(), catalog, base({ explore: explore(0.5, true, seed) }))?.model,
      );
    expect(run(7)).toEqual(run(7));
  });
});

describe("escalation", () => {
  it("retries failed checks once on the same arm, then goes up gradually (effort before a stronger model)", () => {
    const once: PriorAttempt[] = [
      { model: "small", effort: "medium", verdict: "failed", failure: "checks" },
    ];
    const retry = chooseSufficient(task(), catalog, base({ history: once }));
    expect([retry?.model, retry?.effort]).toEqual(["small", "medium"]);
    const twice: PriorAttempt[] = [
      ...once,
      { model: "small", effort: "medium", verdict: "failed", failure: "checks" },
    ];
    const up = chooseSufficient(task(), catalog, base({ history: twice }));
    expect(up?.escalation).toMatch(/escalating/);
    // One rung up the ladder: the same model with more effort, or the next model at its lowest.
    expect(up?.model === "small" ? up.effort : up?.tier).toMatch(/high|standard/);
  });

  it("stops escalating after the most escalations a task may have", () => {
    const history: PriorAttempt[] = [
      { model: "small", effort: "low", verdict: "failed", failure: "agent" },
      { model: "small", effort: "medium", verdict: "failed", failure: "agent" },
      { model: "small", effort: "high", verdict: "failed", failure: "agent" },
    ];
    const held = chooseSufficient(
      task(),
      catalog,
      base({ history, maxEscalations: 2, maxAttempts: 5 }),
    );
    expect([held?.model, held?.effort]).toEqual(["small", "high"]);
    expect(held?.escalation).toMatch(/the most it may/);
  });

  it("environment failures are not the model's: no escalation for them", () => {
    const history: PriorAttempt[] = [
      { model: "small", effort: "medium", verdict: "environment", failure: "usage_limit" },
    ];
    const again = chooseSufficient(task(), catalog, base({ history }));
    expect(again?.escalation).toBeUndefined();
    expect(again?.tier).toBe("light");
  });
});

describe("failure classes", () => {
  it("tell quota, sign-in, tools and infrastructure apart from what the model could do", () => {
    expect(failureClass("usage_limit", "")).toBe("quota");
    expect(failureClass("error", "429 Too Many Requests")).toBe("quota");
    expect(failureClass("setup", "")).toBe("auth");
    expect(failureClass("error", "OpenAI refused the key")).toBe("auth");
    expect(failureClass("error", "npm: command not found")).toBe("tools");
    expect(failureClass("unavailable", "")).toBe("infrastructure");
    expect(failureClass("error", "ECONNRESET while streaming")).toBe("infrastructure");
    expect(failureClass("checks", "2 tests failed")).toBe("verification");
    expect(failureClass("timeout", "")).toBe("context");
    expect(failureClass("agent", "stopped at the step limit")).toBe("context");
    expect(failureClass("error", "the reviewer still asks for changes; a person decides")).toBe(
      "ambiguous",
    );
    expect(failureClass("agent", "the model declined")).toBe("capability");
  });

  it("a check whose own command was broken says nothing of the work; a missing file still does", () => {
    const awk =
      "These checks failed; fix the work so that they pass:\n- `wc -c < greeting.txt | awk '{print $1}' == 5` exited 2:\nawk: fatal: cannot open file `==' for reading: No such file or directory";
    expect(brokenCheck(awk)).toBe(true);
    expect(failureClass("checks", awk)).toBe("ambiguous");
    expect(classifyFailure("checks", awk)).toBe("ambiguous");
    expect(
      brokenCheck("- `test $(cat a) -eq 1` exited 2:\nsh: 1: Syntax error: end of file unexpected"),
    ).toBe(true);
    const missing =
      "- `grep -q hello greeting.txt` exited 2:\ngrep: greeting.txt: No such file or directory";
    expect(brokenCheck(missing)).toBe(false);
    expect(failureClass("checks", missing)).toBe("verification");
    expect(
      brokenCheck(
        "- `awk '{print}' notes.md` exited 2:\nawk: fatal: cannot open file `notes.md' for reading",
      ),
    ).toBe(false);
    expect(failureClass("checks", "- `npm test` exited 1:\n2 failed")).toBe("verification");
  });
});

describe("the simulation's properties (an assumed truth, not real models)", () => {
  it("a leader that always recommends the strongest model no longer sends every task there", async () => {
    const { simTasks, simulate } = await import("../eval/routing-sim.js");
    const tasks = simTasks(200);
    const pinned = simulate(tasks, {
      name: "pin",
      kind: "sufficient",
      mode: "balanced",
      leader: "pinned",
    });
    const advised = simulate(tasks, {
      name: "advice",
      kind: "sufficient",
      mode: "balanced",
      leader: "advice",
    });
    expect(pinned.deep).toBe(1);
    // Easy tasks are not sent to the strongest model on the leader's word.
    expect(advised.deepEasy).toBe(0);
    expect(advised.light).toBeGreaterThan(0.4);
    expect(advised.quota).toBeLessThan(pinned.quota);
    expect(advised.success).toBeGreaterThan(0.95);
  });

  it("exploration happens where cheaper arms were set aside on too little evidence, within its budget", async () => {
    const { simTasks, simulate } = await import("../eval/routing-sim.js");
    const tasks = simTasks(200);
    // Cold, the chosen arm is already the cheapest: nothing cheaper to learn of.
    const cold = simulate(tasks, {
      name: "cold",
      kind: "sufficient",
      mode: "balanced",
      explore: true,
    });
    expect(cold.explored).toBe(0);
    // Bad luck early set the light model aside on a few failures: exploration gives it chances.
    const plain = simulate(tasks, {
      name: "plain",
      kind: "sufficient",
      mode: "balanced",
      biased: true,
    });
    const exploring = simulate(tasks, {
      name: "explore",
      kind: "sufficient",
      mode: "balanced",
      explore: true,
      biased: true,
    });
    expect(plain.explored).toBe(0);
    expect(exploring.explored).toBeGreaterThan(0);
    // At most 2 per run of 20 tasks.
    expect(exploring.explored).toBeLessThanOrEqual((200 / 20) * 2);
    expect(exploring.success).toBeGreaterThan(plain.success - 0.02);
  });
});

describe("models the provider gives no class (a local server)", () => {
  const local: Catalog = {
    models: [
      { id: "default", name: "Default" },
      { id: "gemma-heretic", name: "Gemma heretic" },
      { id: "google/gemma", name: "Gemma" },
    ],
    efforts: [],
    tiers: { deep: ["default"], standard: ["default"], light: ["default"] },
  };

  it("are never ranked by where they come in the list", () => {
    const decision = chooseSufficient(task(), local, base({ provider: "lmstudio" }));
    const [a, b] = decision?.candidates ?? [];
    expect(a?.p).toBe(b?.p);
    expect(a?.prior).toBe(b?.prior);
    expect(decision?.reason).toContain("the provider gives no class");
    const other = decision?.candidates.find((c) => c.verdict === "discarded");
    expect(other?.why).toBe(
      "as likely and as cheap: nothing tells them apart yet (the first listed was taken)",
    );
  });

  it("the leader's recommendation breaks the tie", () => {
    const decision = chooseSufficient(
      task(),
      local,
      base({ provider: "lmstudio", advice: { model: "google/gemma" } }),
    );
    expect(decision?.model).toBe("google/gemma");
    expect(decision?.advice?.followed).toBe(true);
  });

  it("after a model failed, moves sideways to one of the same standing, whichever comes first in the list", () => {
    for (const [failed, other] of [
      ["google/gemma", "gemma-heretic"],
      ["gemma-heretic", "google/gemma"],
    ] as const) {
      const history: PriorAttempt[] = [
        { model: failed, verdict: "failed", failure: "checks" },
        { model: failed, verdict: "failed", failure: "checks" },
      ];
      const decision = chooseSufficient(task(), local, base({ provider: "lmstudio", history }));
      expect(decision?.model).toBe(other);
      expect(decision?.escalation).toMatch(/moving to a model of the same standing/);
      const kept = decision?.candidates.find((c) => c.model === failed);
      expect(kept?.why).toBe("it failed on this task");
    }
  });
});
