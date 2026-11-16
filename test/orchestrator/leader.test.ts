import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describePlan, leaderOption } from "../../src/app/orchestrate.js";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { checkPlan, readAssignee, type TaskSpec } from "../../src/orchestrator/plan.js";
import { describeResult } from "../../src/orchestrator/result.js";
import { readReview, reviewFeedback } from "../../src/orchestrator/review.js";
import { routeAcross, type ProviderEntry } from "../../src/orchestrator/router.js";
import type { ModelChoice, Provider } from "../../src/providers/types.js";

const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function spec(id: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${id}.txt.`,
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: [`${id}.txt`],
    acceptance: [{ check: "files", exist: [`${id}.txt`] }],
    parallelSafe: true,
    ...extra,
  };
}

describe("what the leader writes", () => {
  it("assigns a task to a provider, or a provider and its model", () => {
    expect(readAssignee("codex")).toEqual({ provider: "codex" });
    expect(readAssignee("lmstudio/qwen/qwen3-coder-30b")).toEqual({
      provider: "lmstudio",
      model: "qwen/qwen3-coder-30b",
    });
    expect(readAssignee("Not A Provider")).toBeUndefined();
    expect(readAssignee(undefined)).toBeUndefined();
    const checked = checkPlan({
      goal: "g",
      risks: [],
      tasks: [{ ...spec("a"), assign: "claude-code/opus" }],
    });
    expect(checked.ok && checked.plan.tasks[0]?.assignee).toEqual({
      provider: "claude-code",
      model: "opus",
    });
    expect(leaderOption("codex/gpt-6-astra")).toEqual({
      leader: { provider: "codex", model: "gpt-6-astra" },
    });
    expect(leaderOption("claude-code-local")).toEqual({ leader: { provider: "claude-code" } });
    expect(leaderOption("")).toEqual({});
  });

  it("approves with suggestions, or sends back with issues and suggestions", () => {
    expect(readReview(json({ verdict: "ok", suggestions: ["Reuse parse()", " "] }))).toEqual({
      verdict: "ok",
      suggestions: ["Reuse parse()"],
    });
    const back = readReview(
      json({ verdict: "changes", issues: [{ issue: "No test" }], suggestions: ["Name it x"] }),
    );
    expect(back).toEqual({
      verdict: "changes",
      issues: [{ issue: "No test" }],
      suggestions: ["Name it x"],
    });
    expect(
      reviewFeedback("fake/deep", [{ issue: "No test" }], {
        leader: true,
        suggestions: ["Name it x"],
      }),
    ).toBe(
      "The run's leader (fake/deep) found issues to fix before this task is merged. Fix them, then run the task's checks again:\n- No test\nIts suggestions:\n- Name it x",
    );
  });
});

describe("routing what the leader assigned", () => {
  const catalog = (models: string[]) => ({
    models: models.map((id) => ({ id, name: id })),
    efforts: [],
    tiers: { deep: [models[0] ?? ""], standard: [models[0] ?? ""], light: [models.at(-1) ?? ""] },
  });
  const claude: ProviderEntry = {
    id: "claude-code",
    catalog: catalog(["opus", "sonnet", "haiku"]),
    billing: "subscription",
  };
  const codex: ProviderEntry = {
    id: "codex",
    catalog: catalog(["gpt-6", "gpt-6-mini"]),
    billing: "subscription",
  };

  it("goes to the provider and model the leader chose", () => {
    const route = routeAcross(
      spec("a", {
        kind: "architecture",
        complexity: 5,
        assignee: { provider: "codex", model: "gpt-6-mini" },
      }),
      [claude, codex],
    );
    expect(route.kind === "run" && [route.provider, route.model]).toEqual(["codex", "gpt-6-mini"]);
    expect(route.kind === "run" && route.reasons[0]).toBe("the leader gave it to codex/gpt-6-mini");
  });

  it("follows the usual rules when the leader's provider is not ready or is near its limit", () => {
    const away = routeAcross(spec("a", { assignee: { provider: "gemini" } }), [claude, codex]);
    expect(away.kind === "run" && away.provider).toBe("claude-code");
    const full: ProviderEntry = {
      ...codex,
      usage: { limits: [{ label: "Week", used: 0.9 }], at: new Date() },
    };
    const near = routeAcross(spec("a", { assignee: { provider: "codex" } }), [claude, full]);
    expect(near.kind === "run" && near.provider).toBe("claude-code");
  });
});

describe("a run with a leader", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-leader-"));
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
      // Windows may hold a folder a moment longer.
    }
  });

  /** The leader plans and audits from `audits`; workers write their file, "fixed" once sent back. */
  function provider(audits: string[], seen: { system: string; message: string; model?: string }[]) {
    let audited = 0;
    const make = (choice: ModelChoice) => {
      const turn: FakeTurn = (c) => {
        seen.push({
          system: c.system,
          message: c.message,
          ...(choice.model ? { model: choice.model } : {}),
        });
        if (c.system.includes("You lead a run of sub-agents")) {
          return [
            { say: audits[Math.min(audited++, audits.length - 1)] ?? json({ verdict: "ok" }) },
          ];
        }
        if (c.system.includes("You are the planner")) {
          return [
            {
              say: json({
                goal: "Two files",
                risks: [],
                tasks: [
                  { ...spec("api"), assign: "fake/small" },
                  { ...spec("docs", { kind: "docs", dependsOn: ["api"] }), assign: "fake" },
                ],
              }),
            },
          ];
        }
        const file = /these files exist: (\S+)/.exec(c.message)?.[1] ?? "x.txt";
        const fixed = c.message.includes("The run's leader (");
        return [
          {
            call: "write_file",
            input: { path: file, content: fixed ? "validated\n" : "first try\n" },
          },
          { say: "Done." },
        ];
      };
      return new FakeModel({ turns: [turn] });
    };
    const fake: Provider = {
      id: "fake",
      name: "Fake",
      signIn: "",
      tiers: { deep: ["deep"], standard: ["mid"], light: ["small"] },
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () =>
        Promise.resolve([
          { id: "deep", name: "Deep" },
          { id: "mid", name: "Mid" },
          { id: "small", name: "Small" },
        ]),
      efforts: () => ["low", "medium", "high"],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: make,
    };
    return fake;
  }

  it("plans and assigns the tasks; the plan says who leads", async () => {
    const seen: { system: string; message: string; model?: string }[] = [];
    const orchestrator = new Orchestrator({
      provider: provider([], seen),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
      metrics: false,
      leader: { provider: "fake", model: "deep" },
    });
    const planned = await orchestrator.plan("Write two files");
    expect(planned.leader).toBe("fake/deep");
    const planning = seen.find((s) => s.system.includes("You are the planner"));
    expect(planning?.model).toBe("deep");
    expect(planning?.system).toContain("You are also the leader of this run (fake/deep)");
    expect(planning?.system).toContain("- fake: deep (deep), mid (standard), small (light)");
    const api = planned.routes.get("api");
    expect(api?.kind === "run" && api.model).toBe("small");
    expect(api?.kind === "run" && api.reasons[0]).toBe("the leader gave it to fake/small");
    expect(describePlan(planned)[1]).toBe(
      "Leader: fake/deep · planned it, gave out the tasks, and audits each one",
    );
    orchestrator.close();
  });

  it("audits every task: sends one back, approves it, and its suggestions reach the task after it", async () => {
    const seen: { system: string; message: string; model?: string }[] = [];
    const orchestrator = new Orchestrator({
      provider: provider(
        [
          json({ verdict: "changes", issues: [{ file: "api.txt", issue: "Not validated" }] }),
          json({ verdict: "ok", suggestions: ["Document the validation"] }),
          json({ verdict: "ok" }),
        ],
        seen,
      ),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
      metrics: false,
      leader: { provider: "fake", model: "deep" },
    });
    const tasks = [spec("api"), spec("docs", { kind: "docs", dependsOn: ["api"] })];
    const run = orchestrator.store.createRun("two", { goal: "g", risks: [], tasks }, [
      "api",
      "docs",
    ]);
    const state = await orchestrator.run(run.id);
    expect(state).toBe("completed");
    expect(orchestrator.store.task(run.id, "api")?.attempts).toBe(2);
    const audits = orchestrator.store
      .events(run.id)
      .filter((e) => e.kind === "reviewed")
      .map((e) => [e.taskId, e.data.verdict, e.data.leader, e.data.reviewer]);
    // Docs too: the leader audits every task.
    expect(audits).toEqual([
      ["api", "changes", true, "fake/deep"],
      ["api", "ok", true, "fake/deep"],
      ["docs", "ok", true, "fake/deep"],
    ]);
    // The leader is told what the worker said it did; the worker sent back is told what to fix.
    expect(seen.filter((s) => s.system.includes("You lead a run"))[0]?.message).toContain(
      "What the sub-agent says it did",
    );
    expect(seen.some((s) => s.message.includes("The run's leader (fake/deep) found issues"))).toBe(
      true,
    );
    const docsWorker = seen.find((s) => s.message.startsWith("# Write docs"));
    expect(docsWorker?.message).toContain(
      "The run's leader suggests:\n  - Document the validation",
    );
    expect(git("show", `${orchestrator.integrationBranch(run.id)}:api.txt`)).toBe("validated");
    const result = describeResult(
      orchestrator.store.tasks(run.id),
      orchestrator.store.events(run.id),
      state,
    );
    expect(result.tasks[0]).toBe(
      "The leader (fake/deep) approved 2 tasks and sent work back 1 time.",
    );
    expect(result.tasks[1]).toContain("approved by the leader, sent back 1×, 1 suggestion");
    orchestrator.close();
  });
});
