import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describePlan } from "../../src/app/orchestrate.js";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { TASK_KINDS, type TaskSpec } from "../../src/orchestrator/plan.js";
import {
  DEFAULT_AFFINITY,
  routeAcross,
  type Catalog,
  type ProviderEntry,
} from "../../src/orchestrator/router.js";
import { affinityFor, isAuto, KNOWN_PROVIDERS, providerIds } from "../../src/providers/index.js";
import type { Provider, ProviderUsage } from "../../src/providers/types.js";

const catalog = (prefix: string): Catalog => ({
  models: [
    { id: `${prefix}-big`, name: "Big" },
    { id: `${prefix}-mid`, name: "Mid" },
    { id: `${prefix}-small`, name: "Small" },
  ],
  efforts: ["low", "medium", "high"],
  tiers: { deep: [`${prefix}-big`], standard: [`${prefix}-mid`], light: [`${prefix}-small`] },
});
const usage = (used: number): ProviderUsage => ({
  limits: [{ label: "5 hours", used }],
  at: new Date(),
});
const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: "t",
  title: "T",
  description: "d",
  kind: "frontend",
  dependsOn: [],
  complexity: 2,
  capabilities: ["code"],
  touches: ["a.txt"],
  acceptance: [{ check: "files", exist: ["a.txt"] }],
  parallelSafe: true,
  ...over,
});
const entry = (id: string, used?: number): ProviderEntry => ({
  id,
  catalog: catalog(id),
  ...(used === undefined ? {} : { usage: usage(used) }),
});
const auto = { auto: true, affinity: DEFAULT_AFFINITY } as const;
const pool = () => [entry("claude-code", 0.3), entry("codex", 0.3)];

describe("General Auto: one pool of every provider's models", () => {
  it("sends each kind to its affinity, at the tier its role needs (the user's example)", () => {
    const pick = (kind: TaskSpec["kind"]) => routeAcross(spec({ kind }), pool(), auto);
    expect(pick("architecture")).toMatchObject({
      provider: "claude-code",
      model: "claude-code-mid",
    });
    expect(pick("review")).toMatchObject({ provider: "claude-code", model: "claude-code-big" });
    expect(pick("backend")).toMatchObject({ provider: "claude-code", model: "claude-code-big" });
    expect(pick("docs")).toMatchObject({ provider: "codex", model: "codex-small" });
    expect(pick("tests")).toMatchObject({ provider: "codex", model: "codex-mid" });
    const review = pick("review");
    expect(review.kind === "run" && review.reasons[0]).toBe(
      "review tasks go to claude-code (affinity, deep)",
    );
  });

  it("without an affinity, the provider with the most room takes it", () => {
    const route = routeAcross(spec(), [entry("claude-code", 0.6), entry("codex", 0.2)], auto);
    expect(route).toMatchObject({ provider: "codex", tier: "standard" });
    expect(route.kind === "run" && route.reasons[0]).toBe("codex has the most room");
  });

  it("spreads ties: with the same room, the provider given fewer tasks so far", () => {
    const assigned = new Map([["claude-code", 2]]);
    expect(routeAcross(spec(), pool(), { ...auto, assigned })).toMatchObject({ provider: "codex" });
    const other = new Map([["codex", 3]]);
    expect(routeAcross(spec(), pool(), { ...auto, assigned: other })).toMatchObject({
      provider: "claude-code",
    });
  });

  it("when the affinity's provider is near its limit, another with room takes the task at the role's tier", () => {
    const route = routeAcross(
      spec({ kind: "review" }),
      [entry("claude-code", 0.85), entry("codex", 0.3)],
      auto,
    );
    expect(route).toMatchObject({ provider: "codex", tier: "deep", model: "codex-big" });
    expect(route.kind === "run" && route.reasons[0]).toBe(
      "claude-code has no room for review tasks now",
    );
  });

  it("says when the affinity's provider is not ready", () => {
    const route = routeAcross(spec({ kind: "docs" }), [entry("claude-code", 0.1)], auto);
    expect(route).toMatchObject({ provider: "claude-code", tier: "light" });
    expect(route.kind === "run" && route.reasons[0]).toBe("codex is not ready");
  });

  it("keeps each plan's quota as a hard limit", () => {
    const near = routeAcross(
      spec({ kind: "review" }),
      [entry("claude-code", 0.97), entry("codex", 0.9)],
      auto,
    );
    expect(near).toMatchObject({ provider: "codex", tier: "standard" }); // lighter, never claude
    const none = routeAcross(spec(), [entry("claude-code", 0.99), entry("codex", 0.96)], auto);
    expect(none).toMatchObject({ kind: "hold" });
  });

  it("puts an explicit --provider-for and the planner's recommendation before the affinity", () => {
    expect(
      routeAcross(spec({ kind: "docs" }), pool(), {
        ...auto,
        providerFor: { docs: "claude-code" },
      }),
    ).toMatchObject({ provider: "claude-code", tier: "light" });
    expect(
      routeAcross(spec({ kind: "docs", recommended: { tier: "deep" } }), pool(), auto),
    ).toMatchObject({ provider: "codex", tier: "deep" });
  });

  it("is not used without auto: the providers stay an order of preference", () => {
    expect(routeAcross(spec({ kind: "docs" }), pool())).toMatchObject({ provider: "claude-code" });
  });
});

describe("General Auto settings", () => {
  it("reads AGENT_PROVIDERS=auto as every known provider", () => {
    expect(isAuto("auto")).toBe(true);
    expect(isAuto(" Auto ")).toBe(true);
    expect(isAuto("claude-code")).toBe(false);
    expect(providerIds("auto")).toEqual(Object.keys(KNOWN_PROVIDERS));
  });

  it("starts from the user's affinities, and AGENT_AFFINITY changes or removes them", () => {
    expect(affinityFor(undefined, TASK_KINDS)).toEqual(DEFAULT_AFFINITY);
    const changed = affinityFor("review=codex:standard,docs=none,frontend=claude-code", TASK_KINDS);
    expect(changed.review).toEqual({ provider: "codex", tier: "standard" });
    expect(changed.docs).toBeUndefined();
    expect(changed.frontend).toEqual({ provider: "claude-code" });
    expect(() => affinityFor("review=nobody", TASK_KINDS)).toThrow(/unknown provider/);
    expect(() => affinityFor("review=codex:huge", TASK_KINDS)).toThrow(/kind=provider\[:tier\]/);
    expect(() => affinityFor("cooking=codex", TASK_KINDS)).toThrow(/kind=provider\[:tier\]/);
  });
});

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

describe("an orchestrator in General Auto", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-auto-"));
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

  it("plans with the pool's planner on its own provider, routes by affinity, and both providers finish their tasks", async () => {
    const plan = {
      goal: "Code and docs",
      risks: [],
      tasks: [
        { id: "api", kind: "backend", file: "api.txt" },
        { id: "guide", kind: "docs", file: "guide.txt" },
      ].map((t) => ({
        id: t.id,
        title: `Write ${t.id}`,
        description: `Create ${t.file}.`,
        kind: t.kind,
        dependsOn: [],
        complexity: 1,
        capabilities: ["code"],
        touches: [t.file],
        acceptance: [{ check: "files", exist: [t.file] }],
        parallelSafe: true,
      })),
    };
    const made: string[] = [];
    const planners: string[] = [];
    const writer =
      (who: string): FakeTurn =>
      (c) => {
        if (c.system.includes("You are the planner")) {
          planners.push(who);
          return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
        }
        const id = /Write (\w+)/.exec(c.message)?.[1] ?? "x";
        return [
          { call: "write_file", input: { path: `${id}.txt`, content: `${id} by ${who}\n` } },
          { say: "Done." },
        ];
      };
    // Codex first in the list: the planner still goes to Claude, by affinity.
    const codex = provider("codex", writer("codex"), made);
    const claude = provider("claude-code", writer("claude"), made);
    const orchestrator = new Orchestrator({
      provider: codex,
      providers: [codex, claude],
      auto: true,
      affinity: DEFAULT_AFFINITY,
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
    });
    const planned = await orchestrator.plan("Code and docs");
    expect(planners).toEqual(["claude"]);
    expect(made[0]).toBe("claude-code:claude-code-mid");
    expect(planned.planner).toBe("claude-code/claude-code-mid · high");
    expect(describePlan(planned)[1]).toBe("Planned by claude-code/claude-code-mid · high");
    expect(planned.routes.get("api")).toMatchObject({ provider: "claude-code", tier: "deep" });
    expect(planned.routes.get("guide")).toMatchObject({ provider: "codex", tier: "light" });

    const { run } = await orchestrator.start("Code and docs", planned);
    expect(await orchestrator.run(run.id)).toBe("completed");
    const branch = orchestrator.integrationBranch(run.id);
    expect(git("show", `${branch}:api.txt`)).toBe("api by claude");
    expect(git("show", `${branch}:guide.txt`)).toBe("guide by codex");
    // Phase C: the run's attempts and outcomes reach the metrics, provider and model apart.
    const attempts = orchestrator.metrics?.attempts() ?? [];
    expect(attempts.map((a) => [a.task, a.provider, a.model, a.attempt]).sort()).toEqual([
      ["api", "claude-code", "claude-code-big", 1],
      ["guide", "codex", "codex-small", 1],
    ]);
    expect(
      orchestrator.metrics
        ?.outcomes()
        .map((o) => [o.task, o.state, o.merged])
        .sort(),
    ).toEqual([
      ["api", "completed", true],
      ["guide", "completed", true],
    ]);
    orchestrator.close();
  });
});
