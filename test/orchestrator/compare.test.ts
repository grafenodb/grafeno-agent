import { describe, expect, it } from "vitest";
import { compareFixedLearned, describeComparison } from "../../src/orchestrator/compare.js";
import type { AttemptRecord, TaskOutcome } from "../../src/orchestrator/metrics.js";

let clock = 0;
let next = 0;
/** One finished task on an arm, at the next moment: clean or not, at a cost. */
function task(
  model: string,
  tier: string,
  clean: boolean,
  tokens: number,
  explored = false,
): { attempt: AttemptRecord; outcome: TaskOutcome } {
  const at = new Date(Date.UTC(2026, 10, 15, 0, 0, ++clock)).toISOString();
  const id = `t${String(++next)}`;
  return {
    attempt: {
      run: "r",
      task: id,
      attempt: 1,
      project: "x",
      at,
      kind: "backend",
      complexity: 3,
      provider: "p",
      model,
      effort: "medium",
      tier,
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
      explored,
    },
    outcome: {
      run: "r",
      task: id,
      project: "x",
      at,
      kind: "backend",
      complexity: 3,
      state: "completed",
      attempts: 1,
      checksFailed: clean ? 0 : 1,
      merged: true,
      conflict: false,
    },
  };
}

function replay(tasks: ReturnType<typeof task>[]) {
  return compareFixedLearned(
    tasks.map((t) => t.attempt),
    tasks.map((t) => t.outcome),
  );
}

const repeat = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe("compareFixedLearned", () => {
  it("says where the learned router would have acted, using only what was recorded before each task", () => {
    const tasks = [
      // The rules' arm: 12 tasks, 9 clean, 1000 tokens each.
      ...repeat(12, (i) => task("big", "deep", i < 9, 1000)),
      // A cheaper arm: 12 tasks, all clean, 300 tokens each.
      ...repeat(12, () => task("mid", "standard", true, 300)),
      // The rules go on with the big arm: now the learned router would not.
      ...repeat(5, () => task("big", "deep", true, 1000)),
    ];
    const comparison = replay(tasks);
    expect(comparison.tasks).toBe(29);
    // Not before the cheaper arm had enough tasks. And not the last one: by
    // then the rules' arm was at 13 of 16 clean (81%), and 12 of 12 (a lower
    // bound of 76%) is no longer as good. The replay follows the evidence.
    expect(comparison.differences.map((d) => d.task)).toEqual(
      tasks.slice(24, 28).map((t) => t.outcome.task),
    );
    const first = comparison.differences[0];
    expect(first).toMatchObject({
      cell: "backend · medium",
      rule: "p/big · medium",
      learned: "p/mid · medium",
      tokensSaved: 700,
    });
    expect(first?.risk).toBe(0); // 75% against a lower bound of 76%: nothing put at risk
    expect(comparison.tokensSaved).toBe(2800); // 4 tasks × 700
  });

  it("does not look ahead: a task never sees its own outcome or later ones", () => {
    // The cheaper arm reaches 10 tasks only after the big arm's last task.
    const tasks = [
      ...repeat(12, (i) => task("big", "deep", i < 9, 1000)),
      task("big", "deep", true, 1000),
      ...repeat(12, () => task("mid", "standard", true, 300)),
    ];
    expect(replay(tasks).differences).toEqual([]);
  });

  it("leaves explored tasks out of the replay", () => {
    const tasks = [
      ...repeat(12, (i) => task("big", "deep", i < 9, 1000)),
      ...repeat(12, () => task("mid", "standard", true, 300, true)),
    ];
    expect(replay(tasks).tasks).toBe(12);
  });
});

describe("describeComparison", () => {
  it("says plainly when nothing would change, and gives estimates as estimates", () => {
    expect(describeComparison({ tasks: 0, differences: [], tokensSaved: 0 })).toEqual([
      "No finished tasks to replay yet.",
    ]);
    expect(describeComparison({ tasks: 24, differences: [], tokensSaved: 0 })[0]).toMatch(
      /would have kept the rules' choice for every one/,
    );
    const tasks = [
      ...repeat(12, (i) => task("big", "deep", i < 9, 1000)),
      ...repeat(12, () => task("mid", "standard", true, 300)),
      ...repeat(2, () => task("big", "deep", true, 1000)),
    ];
    const lines = describeComparison(replay(tasks));
    expect(lines[0]).toMatch(/would have chosen differently for 2/);
    expect(lines[1]).toMatch(/estimates from each arm's records, not outcomes/);
    expect(lines[2]).toMatch(/backend · medium: p\/big · medium → p\/mid · medium {2}×2/);
  });
});
