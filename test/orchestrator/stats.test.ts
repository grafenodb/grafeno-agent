import { describe, expect, it } from "vitest";
import type { AttemptRecord, TaskOutcome } from "../../src/orchestrator/metrics.js";
import {
  bandOf,
  computeStats,
  describeStats,
  MIN_SAMPLE,
  wilson,
} from "../../src/orchestrator/stats.js";

let next = 0;
/** One task: its attempts (by arm and outcome) and how it ended. */
function task(
  kind: string,
  complexity: number,
  attempts: {
    provider?: string;
    model: string;
    effort?: string;
    outcome?: string;
    tokens?: number;
  }[],
  end: Partial<TaskOutcome> = {},
): { attempts: AttemptRecord[]; outcome: TaskOutcome } {
  const id = `t${String(++next)}`;
  return {
    attempts: attempts.map((a, index) => ({
      run: "r",
      task: id,
      attempt: index + 1,
      project: "p",
      at: "2026-11-15T10:00:00Z",
      kind,
      complexity,
      provider: a.provider ?? "claude-code",
      model: a.model,
      ...(a.effort ? { effort: a.effort } : {}),
      tier: "light",
      ms: 1000,
      rounds: 1,
      renewals: 0,
      inputTokens: a.tokens ?? 100,
      outputTokens: 0,
      cacheTokens: 0,
      contextPeak: 0,
      window: 200_000,
      windowEstimated: false,
      outcome: a.outcome ?? "completed",
      explored: false,
    })),
    outcome: {
      run: "r",
      task: id,
      project: "p",
      at: "2026-11-15T10:00:00Z",
      kind,
      complexity,
      state: "completed",
      attempts: attempts.length,
      checksFailed: 0,
      merged: true,
      conflict: false,
      ...end,
    },
  };
}

function stats(tasks: ReturnType<typeof task>[]) {
  return computeStats(
    tasks.flatMap((t) => t.attempts),
    tasks.map((t) => t.outcome),
  );
}

describe("wilson", () => {
  it("is wide for a small sample and narrow for a large one", () => {
    const small = wilson(3, 3);
    expect(small.rate).toBe(1);
    expect(small.low).toBeCloseTo(0.438, 2);
    const large = wilson(95, 100);
    expect(large.low).toBeGreaterThan(0.88);
    expect(large.high).toBeLessThan(0.98);
    expect(wilson(0, 0)).toMatchObject({ low: 0, high: 1 });
  });
});

describe("computeStats", () => {
  it("compares tasks only within a cell: their kind and complexity band", () => {
    expect([bandOf(1), bandOf(2), bandOf(3), bandOf(4), bandOf(5)]).toEqual([
      "low",
      "low",
      "medium",
      "high",
      "high",
    ]);
    const cells = stats([
      task("docs", 1, [{ model: "haiku" }]),
      task("docs", 2, [{ model: "haiku" }]),
      task("docs", 4, [{ model: "opus" }]),
      task("tests", 1, [{ model: "haiku" }]),
    ]);
    expect(cells.map((c) => [c.key, c.tasks])).toEqual([
      ["docs · high", 1],
      ["docs · low", 2],
      ["tests · low", 1],
    ]);
  });

  it("counts clean success, success, cost and time per arm", () => {
    const cells = stats([
      task("backend", 3, [{ model: "sonnet", effort: "medium", tokens: 1000 }]),
      task("backend", 3, [{ model: "sonnet", effort: "medium", tokens: 3000 }], {
        checksFailed: 1,
      }),
      task("backend", 3, [{ model: "sonnet", effort: "medium" }], {
        state: "failed",
        merged: false,
      }),
    ]);
    const arm = cells[0]?.arms[0];
    expect(arm?.key).toBe("claude-code/sonnet · medium");
    expect(arm?.tasks).toBe(3);
    expect(arm?.clean.successes).toBe(1); // the fixed check is not clean
    expect(arm?.success.successes).toBe(2);
    expect(arm?.cost).toBe(1367);
    expect(arm?.enough).toBe(false);
  });

  it("counts a task for the arm of its final attempt, leaving out limits and moves", () => {
    const cells = stats([
      task("tests", 1, [
        { provider: "claude-code", model: "haiku", outcome: "quota" },
        { provider: "codex", model: "luna" },
      ]),
      task("tests", 1, [{ model: "haiku", outcome: "retry" }, { model: "haiku" }]),
    ]);
    const arms = cells[0]?.arms ?? [];
    expect(arms.map((a) => [a.key, a.tasks, a.clean.successes])).toEqual([
      ["claude-code/haiku", 1, 0], // a retry before it: not clean
      ["codex/luna", 1, 1], // the limit was not the model's doing
    ]);
  });

  it("says when an arm has enough tasks to count", () => {
    const many = Array.from({ length: MIN_SAMPLE }, () => task("docs", 1, [{ model: "haiku" }]));
    expect(stats(many)[0]?.arms[0]?.enough).toBe(true);
  });

  it("leaves out tasks with no attempt the model was to blame for", () => {
    expect(stats([task("docs", 1, [{ model: "haiku", outcome: "moved" }])])).toEqual([]);
  });
});

describe("describeStats", () => {
  it("shows small samples as such, and says when nothing is recorded", () => {
    expect(describeStats([], 0)).toEqual([
      "No finished tasks are recorded yet: the router uses its rules.",
    ]);
    const lines = describeStats(stats([task("docs", 1, [{ model: "haiku" }])]), 1);
    expect(lines.join("\n")).toMatch(/docs · low {2}\(1 task\)/);
    expect(lines.join("\n")).toMatch(
      /claude-code\/haiku .* 100% clean \[21%–100%\] .* small sample/,
    );
    expect(lines[1]).toMatch(/compare them within a provider/);
  });
});
