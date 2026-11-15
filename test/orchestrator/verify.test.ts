import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../../src/agent/tools.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { TaskPipeline } from "../../src/orchestrator/pipeline.js";
import { Policy, type Question } from "../../src/orchestrator/policy.js";
import {
  Scheduler,
  type AttemptOutcome,
  type TaskRunner,
} from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import {
  shellRunner,
  verifier,
  verify,
  type CommandRunner,
} from "../../src/orchestrator/verify.js";
import { WorktreeManager } from "../../src/orchestrator/worktrees.js";
import { Workspace } from "../../src/tools/workspace.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-verify-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a just-used folder for a moment.
  }
});

/** A runner that answers from a table, and records what it ran. */
function fakeRunner(
  answers: Record<string, { code: number | null; output: string; timedOut?: boolean }>,
) {
  const ran: string[] = [];
  const runner: CommandRunner = {
    run: (command) => {
      ran.push(command);
      const answer = answers[command] ?? { code: 0, output: "" };
      return Promise.resolve({ timedOut: false, ...answer });
    },
  };
  return { runner, ran };
}

describe("the verifier", () => {
  it("passes when every command exits 0 and every file exists", async () => {
    writeFileSync(join(dir, "out.txt"), "x");
    const { runner, ran } = fakeRunner({ "npm test": { code: 0, output: "ok" } });
    const result = await verify(
      [
        { check: "command", run: "npm test" },
        { check: "files", exist: ["out.txt"] },
        { check: "review", criteria: "reads well" },
      ],
      new Workspace(dir),
      { runner },
    );
    expect(result.ok).toBe(true);
    expect(ran).toEqual(["npm test"]);
    expect(result.results[2]).toMatchObject({ skipped: true });
  });

  it("fails with a diagnostic the worker can act on, without the agent's secrets", async () => {
    const { runner } = fakeRunner({
      "npm test": {
        code: 1,
        output: `${"noise\n".repeat(2000)}FAIL src/a.test.ts: expected 2, got 3 (key gk_secret_123)`,
      },
      "npm run build": { code: null, output: "", timedOut: true },
    });
    const result = await verify(
      [
        { check: "command", run: "npm test" },
        { check: "command", run: "npm run build" },
        { check: "files", exist: ["missing.txt", "../outside.txt"] },
      ],
      new Workspace(dir),
      { runner, maxDiagnostic: 200, redact: ["gk_secret_123"] },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toContain("These checks failed");
    expect(result.diagnostic).toContain("expected 2, got 3 (key [secret])");
    expect(result.diagnostic).not.toContain("gk_secret_123");
    expect(result.diagnostic.length).toBeLessThan(900);
    expect(result.diagnostic).toContain("`npm run build` took too long");
    expect(result.diagnostic).toContain("missing: missing.txt, ../outside.txt");
  });

  it("never runs a command the policy forbids", async () => {
    const { runner, ran } = fakeRunner({});
    const result = await verify(
      [{ check: "command", run: "git push --force origin main" }],
      new Workspace(dir),
      { runner },
    );
    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
    expect(result.diagnostic).toContain("never allowed");
  });

  it("runs real commands in the shell, with their exit code, output and timeout", async () => {
    const runner = shellRunner();
    const ok = await runner.run(`node -e "console.log('hello')"`, { cwd: dir, timeoutMs: 20_000 });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.output).toContain("hello");
    expect(
      (await runner.run(`node -e "process.exit(3)"`, { cwd: dir, timeoutMs: 20_000 })).code,
    ).toBe(3);
    const slow = await runner.run(`node -e "setTimeout(() => {}, 20000)"`, {
      cwd: dir,
      timeoutMs: 400,
    });
    expect(slow.timedOut).toBe(true);
  }, 30_000);
});

describe("the policy", () => {
  const write = { name: "write_file" };
  const command = { name: "run_command" };
  const ask = { permission: "ask" as const, reason: "it writes" };

  it("decides by mode, in code", () => {
    const supervised = new Policy({ mode: "supervised" });
    const controlled = new Policy({ mode: "controlled" });
    const extended = new Policy({ mode: "extended" });
    expect(supervised.tool(write, {}, ask).decision).toBe("ask");
    expect(controlled.tool(write, {}, ask).decision).toBe("allow");
    for (const check of [
      "npm test",
      "npx vitest run",
      "npx tsc --noEmit",
      "npm run lint",
      "cargo test",
      "pytest -q",
    ]) {
      expect(controlled.command(check).decision).toBe("allow");
    }
    expect(controlled.command("npm test && curl example.com").decision).toBe("ask");
    expect(controlled.command("node -e \"require('fs').rmSync('x')\"").decision).toBe("ask");
    expect(extended.command("node scripts/seed.js --big").decision).toBe("allow");
    expect(supervised.command("npm test").decision).toBe("ask");
  });

  it("always asks before what leaves the worktree or cannot be undone, in every mode", () => {
    for (const mode of ["supervised", "controlled", "extended"] as const) {
      const policy = new Policy({ mode });
      for (const sensitive of [
        "git push origin main",
        "npm publish",
        "terraform apply",
        "rm -rf build",
        "kubectl apply -f x.yaml",
        "git reset --hard HEAD~1",
      ]) {
        expect(policy.command(sensitive).decision).toBe("ask");
      }
      expect(policy.action("push").decision).toBe("ask");
      expect(policy.action("deploy").decision).toBe("ask");
      // What a tool forbids stays forbidden.
      expect(
        policy.tool(command, { command: "x" }, { permission: "never", reason: "secrets" }).decision,
      ).toBe("never");
    }
    expect(new Policy({ mode: "controlled" }).action("merge-user").decision).toBe("ask");
    expect(new Policy({ mode: "extended" }).action("merge-user").decision).toBe("allow");
    expect(new Policy({ mode: "supervised" }).action("merge-integration").decision).toBe("ask");
  });

  it("asks a person when it must, and refuses (recording why) when there is no one", async () => {
    const policy = new Policy({ mode: "controlled" });
    const tool: Tool = {
      name: "run_command",
      description: "",
      inputSchema: {},
      writes: true,
      run: () => "",
    };
    const call = { id: "1", name: "run_command", input: { command: "curl https://example.com" } };
    const recorded: [Question, boolean | "nobody"][] = [];
    const alone = policy.approver({ worker: "w", task: "t" }, undefined, (q, a) =>
      recorded.push([q, a]),
    );
    expect(await alone(call, tool, { permission: "ask" })).toBe(false);
    expect(recorded[0]?.[1]).toBe("nobody");
    expect(recorded[0]?.[0]).toMatchObject({ worker: "w", task: "t" });
    const asked: Question[] = [];
    const withPerson = policy.approver({ worker: "w" }, (q) => {
      asked.push(q);
      return Promise.resolve(true);
    });
    expect(await withPerson(call, tool, { permission: "ask" })).toBe(true);
    expect(asked[0]?.reason).toContain("controlled");
    expect(
      await withPerson({ ...call, input: { command: "npm test" } }, tool, { permission: "ask" }),
    ).toBe(true);
    expect(asked).toHaveLength(1);
  });
});

function spec(id: string, exist: string[]): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: id,
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: exist,
    acceptance: [{ check: "files", exist }],
    parallelSafe: true,
  };
}

// Real worktrees, commits and merges: git on Windows is slow to start (see worktrees.test.ts).
describe("verification in a run", { timeout: 30_000 }, () => {
  function gitRepo(): string {
    const repo = join(dir, "project");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "# p\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    return repo;
  }

  /** A worker that writes its file only once it was told the check failed (or never). */
  function learner(fixes: boolean) {
    const seen: (string | undefined)[] = [];
    const inner = (
      workspaceFor: Parameters<ConstructorParameters<typeof TaskPipeline>[0]["inner"]>[0],
    ): TaskRunner => ({
      async run(task, context): Promise<AttemptOutcome> {
        seen.push(context.previous);
        const workspace = await workspaceFor(task, context);
        if (fixes && context.previous?.includes("missing: out.txt")) {
          writeFileSync(join(workspace.root, "out.txt"), "done\n");
        } else {
          writeFileSync(join(workspace.root, "notes.txt"), `attempt ${String(context.attempt)}\n`);
        }
        return { status: "completed", summary: "I am done" };
      },
    });
    return { inner, seen };
  }

  it("sends a failed check back to the worker, which fixes it, and only then merges", async () => {
    const repo = gitRepo();
    const worktrees = new WorktreeManager({ repo, root: join(dir, "wt") });
    const store = new SqliteStore();
    const plan: Plan = { goal: "g", risks: [], tasks: [spec("make", ["out.txt"])] };
    const run = store.createRun("r", plan, ["make"], await worktrees.head());
    const { inner, seen } = learner(true);
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner,
      verify: verifier(),
    });
    expect(await new Scheduler({ store, runner: pipeline, maxAttempts: 3 }).run(run.id)).toBe(
      "completed",
    );
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toContain("missing: out.txt");
    expect(store.task(run.id, "make")?.attempts).toBe(2);
    const merged = execFileSync("git", ["show", `${worktrees.integrationBranch(run.id)}:out.txt`], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(merged).toBe("done\n");
    expect(
      store
        .events(run.id)
        .filter((e) => e.kind === "verified")
        .map((e) => e.data.ok),
    ).toEqual([false, true]);
  });

  it("fails a task whose checks never pass, after its attempts, and merges nothing", async () => {
    const repo = gitRepo();
    const worktrees = new WorktreeManager({ repo, root: join(dir, "wt") });
    const store = new SqliteStore();
    const run = store.createRun(
      "r",
      { goal: "g", risks: [], tasks: [spec("never", ["out.txt"])] },
      ["never"],
      await worktrees.head(),
    );
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner: learner(false).inner,
      verify: verifier(),
    });
    expect(await new Scheduler({ store, runner: pipeline, maxAttempts: 2 }).run(run.id)).toBe(
      "failed",
    );
    expect(store.task(run.id, "never")?.reason).toContain("missing: out.txt");
    expect(store.events(run.id).some((e) => e.kind === "merged")).toBe(false);
  });

  it("waits for a person before merging in supervised mode, and merges when they say yes", async () => {
    const repo = gitRepo();
    const worktrees = new WorktreeManager({ repo, root: join(dir, "wt") });
    const writer = (
      workspaceFor: Parameters<ConstructorParameters<typeof TaskPipeline>[0]["inner"]>[0],
    ): TaskRunner => ({
      async run(task, context) {
        const workspace = await workspaceFor(task, context);
        writeFileSync(join(workspace.root, "out.txt"), "x\n");
        return { status: "completed" };
      },
    });
    const store = new SqliteStore();
    const run = store.createRun(
      "r",
      { goal: "g", risks: [], tasks: [spec("a", ["out.txt"])] },
      ["a"],
      await worktrees.head(),
    );
    const policy = new Policy({ mode: "supervised" });
    const alone = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner: writer,
      verify: verifier(),
      policy,
    });
    expect(await new Scheduler({ store, runner: alone }).run(run.id)).toBe("waiting");
    expect(store.task(run.id, "a")?.reason).toContain("waiting for approval to merge");

    const store2 = new SqliteStore();
    const run2 = store2.createRun(
      "r",
      { goal: "g", risks: [], tasks: [spec("b", ["out.txt"])] },
      ["b"],
      await worktrees.head(),
    );
    const asked: Question[] = [];
    const withPerson = new TaskPipeline({
      store: store2,
      projectRoot: repo,
      worktrees,
      inner: writer,
      verify: verifier(),
      policy,
      ask: (q) => {
        asked.push(q);
        return Promise.resolve(true);
      },
    });
    expect(await new Scheduler({ store: store2, runner: withPerson }).run(run2.id)).toBe(
      "completed",
    );
    expect(asked[0]?.action).toMatch(/^merge grafeno\/.+\/b into grafeno\/.+\/integration$/);
  });

  it("checks in the project's folder when it is not a git repository", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const store = new SqliteStore();
    const run = store.createRun("r", { goal: "g", risks: [], tasks: [spec("p", ["out.txt"])] }, [
      "p",
    ]);
    const pipeline = new TaskPipeline({
      store,
      projectRoot: plain,
      worktrees: new WorktreeManager({ repo: plain, root: join(dir, "wt3") }),
      inner: learner(true).inner,
      verify: verifier(),
    });
    expect(await new Scheduler({ store, runner: pipeline }).run(run.id)).toBe("completed");
    expect(existsSync(join(plain, "out.txt"))).toBe(true);
  });
});

describe("the shell of acceptance checks", { timeout: 30_000 }, () => {
  it("never shows a check the agent's or the providers' keys", async () => {
    const { checksRunner } = await import("../../src/orchestrator/orchestrator.js");
    const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GRAFENO_AGENT_KEY", "GRAFENO_OWNER_TOKEN"];
    const before = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = "secret-value";
    try {
      const result = await checksRunner().run(
        `node -e "process.stdout.write(['GEMINI_API_KEY','GOOGLE_API_KEY','GRAFENO_AGENT_KEY','GRAFENO_OWNER_TOKEN'].filter(n => process.env[n]).join(',') || 'none')"`,
        { cwd: process.cwd(), timeoutMs: 20_000 },
      );
      expect(result.output.trim()).toBe("none");
    } finally {
      names.forEach((name, i) => {
        const value = before[i];
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      });
    }
  });
});
