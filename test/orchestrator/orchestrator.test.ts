import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Question } from "../../src/orchestrator/policy.js";
import type { ModelChoice, Provider } from "../../src/providers/types.js";

let dir: string;
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-orch-"));
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

const PLAN = {
  goal: "Three small modules and a summary",
  risks: [],
  tasks: [
    ...["slugify", "clamp", "chunk"].map((id) => ({
      id,
      title: `Write ${id}`,
      description: `Create src/${id}.js exporting ${id}.`,
      kind: "backend",
      dependsOn: [],
      complexity: 1,
      capabilities: ["code"],
      touches: [`src/${id}.js`],
      acceptance: [{ check: "files", exist: [`src/${id}.js`] }],
      parallelSafe: true,
      recommended: { tier: "light", effort: "low" },
    })),
    {
      id: "summary",
      title: "Write the summary",
      description: "List the modules in MODULES.md.",
      kind: "docs",
      dependsOn: ["slugify", "clamp", "chunk"],
      complexity: 1,
      capabilities: ["code"],
      touches: ["MODULES.md"],
      acceptance: [{ check: "files", exist: ["MODULES.md"] }],
      parallelSafe: true,
    },
  ],
};

/** A provider whose planner answers with PLAN and whose workers write their task's file. */
function provider(chosen: ModelChoice[]): Provider {
  const worker: FakeTurn = (context) => {
    if (
      context.message.includes("Turn the user's request") ||
      context.system.includes("You are the planner")
    ) {
      return [{ say: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`` }];
    }
    const file = /these files exist: (\S+)/.exec(context.message)?.[1] ?? "x.txt";
    return [
      { wait: 2500 },
      { call: "write_file", input: { path: file, content: `// ${file}\n` } },
      { say: `Wrote ${file}.` },
    ];
  };
  return {
    id: "fake",
    name: "Fake",
    signIn: "",
    tiers: { deep: ["big"], standard: ["mid"], light: ["small"] },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () =>
      Promise.resolve([
        { id: "big", name: "Big" },
        { id: "mid", name: "Mid" },
        { id: "small", name: "Small" },
      ]),
    efforts: () => ["low", "medium", "high"],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: (choice) => {
      chosen.push(choice);
      return new FakeModel({ turns: [worker] });
    },
  };
}

describe("the orchestrator", { timeout: 60_000 }, () => {
  it("plans, runs three workers at once in worktrees, verifies and merges everything", async () => {
    const chosen: ModelChoice[] = [];
    let workers = 0;
    let tasks = 0;
    const running = new Set<string>();
    const orchestrator = new Orchestrator({
      provider: provider(chosen),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
      onWorkers: (active) => {
        workers = Math.max(workers, active.length);
      },
      onChange: (change) => {
        if (change.type !== "task") return;
        if (change.state === "running") running.add(change.task);
        else running.delete(change.task);
        tasks = Math.max(tasks, running.size);
      },
    });
    const planned = await orchestrator.plan("Write slugify, clamp and chunk, then a summary");
    expect(planned.plan.tasks).toHaveLength(4);
    expect(planned.routes.get("slugify")).toMatchObject({
      kind: "run",
      model: "small",
      effort: "low",
    });
    expect(chosen[0]).toEqual({ model: "big", effort: "high" });

    const { run, uncommitted } = await orchestrator.start("Write them", planned);
    expect(uncommitted).toEqual([]);
    expect(run.baseCommit).toBe(git("rev-parse", "HEAD"));
    expect(await orchestrator.run(run.id)).toBe("completed");
    // Three tasks run at once; their workers overlap once their worktrees exist
    // (worktrees are made one at a time: git locks the list of them).
    expect(tasks).toBe(3);
    expect(workers).toBeGreaterThanOrEqual(2);

    const branch = orchestrator.integrationBranch(run.id);
    for (const file of ["src/slugify.js", "src/clamp.js", "src/chunk.js", "MODULES.md"]) {
      expect(git("show", `${branch}:${file}`)).toBe(`// ${file}`);
    }
    // The user's branch and tree are as they were.
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("status", "--porcelain")).toBe("");
    const report = orchestrator.report(run.id);
    expect(report.state).toBe("completed");
    expect(report.tasks.every((t) => t.merged)).toBe(true);
    expect(report.totals.attempts).toBe(4);
    orchestrator.close();
  });

  it("keeps a run in its store, so another process resumes it", async () => {
    const options = {
      provider: provider([]),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
    };
    const first = new Orchestrator(options);
    const planned = await first.plan("Write them");
    const { run } = await first.start("Write them", planned);
    const running = first.run(run.id);
    first.pause();
    expect(await running).toBe("paused");
    first.close();

    const second = new Orchestrator(options);
    expect(second.runs().map((r) => r.id)).toContain(run.id);
    expect(await second.run(run.id)).toBe("completed");
    expect(git("show", `${second.integrationBranch(run.id)}:MODULES.md`)).toBe("// MODULES.md");
    second.close();
  });

  // Both found by the first real run on Claude (2026-11-15): a task that
  // depends on another started from the run's base and did not see its work,
  // and in `controlled` workers could not run their own acceptance commands.
  it("starts a dependant from its dependencies' merged work, and lets workers run their own checks", async () => {
    const MODULE_CHECK = `node -e "require('fs').statSync('src/m.js')"`;
    const USES_CHECK = `node -e "require('fs').statSync('src/m.js');require('fs').statSync('USES.md')"`;
    const plan = {
      goal: "A module and a file that uses it",
      risks: [],
      tasks: [
        {
          id: "module",
          title: "Write the module",
          description: "Create src/m.js.",
          kind: "backend",
          dependsOn: [],
          complexity: 1,
          capabilities: ["code"],
          touches: ["src/m.js"],
          acceptance: [{ check: "command", run: MODULE_CHECK }],
          parallelSafe: true,
        },
        {
          id: "uses",
          title: "Use the module",
          description: "Write USES.md, next to src/m.js from the module task.",
          kind: "docs",
          dependsOn: ["module"],
          complexity: 1,
          capabilities: ["code"],
          touches: ["USES.md"],
          acceptance: [{ check: "command", run: USES_CHECK }],
          parallelSafe: true,
        },
      ],
    };
    const turn: FakeTurn = (context) => {
      if (context.system.includes("You are the planner")) {
        return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
      }
      const uses = context.message.includes("Use the module");
      return [
        uses
          ? { call: "write_file", input: { path: "USES.md", content: "uses m\n" } }
          : { call: "write_file", input: { path: "src/m.js", content: "export const m = 1;\n" } },
        { call: "run_command", input: { command: uses ? USES_CHECK : MODULE_CHECK } },
        { say: (c) => `Checked: ${c.results[1]?.content.split("\n")[0] ?? "?"}` },
      ];
    };
    const fake: Provider = { ...provider([]), create: () => new FakeModel({ turns: [turn] }) };
    const orchestrator = new Orchestrator({
      provider: fake,
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
    });
    const planned = await orchestrator.plan("A module and its use");
    const { run } = await orchestrator.start("A module and its use", planned);
    expect(await orchestrator.run(run.id)).toBe("completed");

    const events = orchestrator.store.events(run.id);
    // No worker had to ask (nobody could have answered): its own checks ran.
    expect(events.filter((e) => e.kind === "question")).toEqual([]);
    const summaries = events
      .filter((e) => e.kind === "attempt_ended")
      .map((e) => String((e.data as { summary?: string }).summary));
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) expect(summary).toMatch(/^Checked: Exit code 0./);
    // Each task's own files only: the dependency's file is not counted as the dependant's.
    const merged = events
      .filter((e) => e.kind === "merged")
      .map((e) => [e.taskId, (e.data as { files?: string[] }).files]);
    expect(merged).toEqual([
      ["module", ["src/m.js"]],
      ["uses", ["USES.md"]],
    ]);
    orchestrator.close();
  });

  it("asks a person before writing in supervised mode", async () => {
    const questions: Question[] = [];
    const orchestrator = new Orchestrator({
      provider: provider([]),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
      mode: "supervised",
      ask: (q) => {
        questions.push(q);
        return Promise.resolve(true);
      },
    });
    const planned = await orchestrator.plan("Write them");
    const { run } = await orchestrator.start("Write them", planned);
    expect(await orchestrator.run(run.id)).toBe("completed");
    expect(questions.some((q) => q.action.includes("write") || q.action.includes("src/"))).toBe(
      true,
    );
    expect(questions.some((q) => q.action.startsWith("merge "))).toBe(true);
    orchestrator.close();
  });
});
