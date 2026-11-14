import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import { checkPlan, readyTasks, topologicalOrder } from "../../src/orchestrator/plan.js";
import { extractJson, makePlan, PlanError } from "../../src/orchestrator/planner.js";

/** A task with what every task needs; `extra` changes it. */
function task(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
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

const plan = (tasks: unknown[]) => ({ goal: "Build it", risks: ["time"], tasks });

describe("checkPlan", () => {
  it("accepts a valid DAG and orders it by its dependencies", () => {
    const checked = checkPlan(
      plan([
        task("api", { dependsOn: ["contracts"] }),
        task("contracts", { kind: "architecture", recommended: { tier: "deep", effort: "high" } }),
        task("ui", { kind: "frontend", dependsOn: ["contracts"] }),
        task("tests", { kind: "tests", dependsOn: ["api", "ui"] }),
      ]),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.order).toEqual(["contracts", "api", "ui", "tests"]);
    expect(checked.plan.tasks[1]?.recommended).toEqual({ tier: "deep", effort: "high" });
  });

  it("refuses cycles, naming them", () => {
    const checked = checkPlan(
      plan([
        task("a", { dependsOn: ["c"] }),
        task("b", { dependsOn: ["a"] }),
        task("c", { dependsOn: ["b"] }),
      ]),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.join()).toMatch(/cycle: (a|b|c) → .* → (a|b|c)/);
  });

  it("refuses dangling and self dependencies, duplicate ids and bad ids", () => {
    const checked = checkPlan(
      plan([
        task("a", { dependsOn: ["ghost"] }),
        task("b", { dependsOn: ["b"] }),
        task("a"),
        task("Bad Id"),
      ]),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const all = checked.problems.join("\n");
    expect(all).toContain('depends on "ghost", which is not in the plan');
    expect(all).toContain('task "b" depends on itself');
    expect(all).toContain('task id "a" is used twice');
    expect(all).toContain("no valid id");
  });

  it("refuses tasks that code cannot check", () => {
    const checked = checkPlan(
      plan([
        task("none", { acceptance: [] }),
        task("review-only", { acceptance: [{ check: "review", criteria: "looks good" }] }),
      ]),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.join("\n")).toContain('task "none" has no acceptance');
    expect(checked.problems.join("\n")).toContain(
      'task "review-only" is accepted only by a review',
    );
  });

  it("refuses forbidden commands, paths outside the project and unknown kinds", () => {
    const checked = checkPlan(
      plan([
        task("push", { acceptance: [{ check: "command", run: "git push --force origin main" }] }),
        task("escape", { touches: ["../other-project/x.ts"] }),
        task("odd", { kind: "deploy" }),
      ]),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const all = checked.problems.join("\n");
    expect(all).toContain("forbidden command");
    expect(all).toContain("outside the project");
    expect(all).toContain('unknown kind "deploy"');
  });

  it("refuses what is not a plan", () => {
    expect(checkPlan("hello")).toEqual({ ok: false, problems: ["the plan is not an object"] });
    expect(checkPlan({ goal: "x", tasks: [] })).toMatchObject({ ok: false });
  });
});

describe("the DAG", () => {
  it("knows what is ready from what is done and running", () => {
    const checked = checkPlan(plan([task("a"), task("b"), task("c", { dependsOn: ["a", "b"] })]));
    if (!checked.ok) throw new Error("expected a plan");
    expect(readyTasks(checked.plan, new Set()).map((t) => t.id)).toEqual(["a", "b"]);
    expect(readyTasks(checked.plan, new Set(["a"]), new Set(["b"])).map((t) => t.id)).toEqual([]);
    expect(readyTasks(checked.plan, new Set(["a", "b"])).map((t) => t.id)).toEqual(["c"]);
    expect(topologicalOrder([{ id: "x", dependsOn: ["x"] }])).toEqual({ cycle: ["x", "x"] });
  });
});

describe("the planner", () => {
  const valid = plan([
    task("contracts", { kind: "architecture" }),
    task("api", { dependsOn: ["contracts"] }),
  ]);
  const cyclic = plan([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]);

  it("returns a checked plan, repairing it from the problems found", async () => {
    const model = new FakeModel({
      turns: [
        [{ say: `Here is the plan:\n\`\`\`json\n${JSON.stringify(cyclic)}\n\`\`\`` }],
        [
          {
            say: (context) =>
              context.message.includes("cycle")
                ? `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``
                : "no",
          },
        ],
      ],
    });
    const planned = await makePlan(
      { request: "Build an API", context: "src/ is empty" },
      { model },
    );
    expect(planned.attempts).toBe(2);
    expect(planned.order).toEqual(["contracts", "api"]);
  });

  it("fails with every problem when no valid plan comes", async () => {
    const model = new FakeModel({ turns: [[{ say: "I would rather chat." }]] });
    await expect(
      makePlan({ request: "Build it" }, { model, maxRepairs: 1 }),
    ).rejects.toBeInstanceOf(PlanError);
    try {
      await makePlan(
        { request: "Build it" },
        { model: new FakeModel({ turns: [[{ say: "no plan" }]] }), maxRepairs: 0 },
      );
    } catch (error) {
      expect((error as PlanError).problems).toEqual(["the answer has no JSON plan"]);
      expect((error as PlanError).attempts).toBe(1);
    }
  });

  it("finds the JSON in fenced or bare answers", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure. {"a":2} Done.')).toEqual({ a: 2 });
    expect(extractJson("nothing")).toBeUndefined();
  });
});
