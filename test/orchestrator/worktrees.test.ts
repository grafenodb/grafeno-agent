import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { TaskPipeline } from "../../src/orchestrator/pipeline.js";
import {
  Scheduler,
  type AttemptOutcome,
  type TaskRunner,
} from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { WorktreeManager } from "../../src/orchestrator/worktrees.js";

let dir: string;
let repo: string;
let manager: WorktreeManager;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-wt-"));
  repo = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "README.md"), "# Project\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "start");
  manager = new WorktreeManager({ repo, root: join(dir, "wt") });
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a just-used folder for a moment.
  }
});

describe("WorktreeManager", () => {
  it("gives each task its own worktree and branch, and merges finished work into the integration branch", async () => {
    const base = await manager.head();
    const api = await manager.prepare("run-2026-11-14-aaaa1111", "api", base);
    const ui = await manager.prepare("run-2026-11-14-aaaa1111", "ui", base);
    expect(api.path).not.toBe(ui.path);
    expect(api.branch).toBe("grafeno/aaaa1111/api");
    writeFileSync(join(api.path, "api.ts"), "export const api = 1;\n");
    writeFileSync(join(ui.path, "ui.tsx"), "export const ui = 1;\n");
    expect(await manager.commit(api, "API", "worker-api")).toMatch(/^[0-9a-f]{40}$/);
    expect(await manager.commit(ui, "UI", "worker-ui")).toMatch(/^[0-9a-f]{40}$/);
    const first = await manager.integrate("run-2026-11-14-aaaa1111", "api", base, "worker-api");
    const second = await manager.integrate("run-2026-11-14-aaaa1111", "ui", base, "worker-ui");
    expect(first).toMatchObject({ status: "merged", files: ["api.ts"] });
    expect(second).toMatchObject({ status: "merged", files: ["ui.tsx"] });
    const integration = manager.integrationBranch("run-2026-11-14-aaaa1111");
    expect(git(repo, "show", `${integration}:api.ts`)).toBe("export const api = 1;");
    expect(git(repo, "show", `${integration}:ui.tsx`)).toBe("export const ui = 1;");
    expect(git(repo, "log", "-1", "--format=%an", "grafeno/aaaa1111/api")).toBe(
      "Grafeno Agent (worker-api)",
    );
  });

  it("never writes the user's working tree, branch or uncommitted changes", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nthe user's own change\n");
    const before = git(repo, "rev-parse", "HEAD");
    expect(await manager.uncommitted()).toEqual(["a.txt"]);
    const base = await manager.head();
    const task = await manager.prepare("run-x-bbbb2222", "t", base);
    writeFileSync(join(task.path, "a.txt"), "one\nTWO\nthree\n");
    await manager.commit(task, "change a", "worker-t");
    await manager.integrate("run-x-bbbb2222", "t", base, "worker-t");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe(
      "one\ntwo\nthree\nthe user's own change\n",
    );
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(task.path, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
  });

  it("detects a conflict, leaves the integration branch as it was, and names the files", async () => {
    const base = await manager.head();
    const one = await manager.prepare("run-x-cccc3333", "one", base);
    const two = await manager.prepare("run-x-cccc3333", "two", base);
    writeFileSync(join(one.path, "a.txt"), "one\nFIRST\nthree\n");
    writeFileSync(join(two.path, "a.txt"), "one\nSECOND\nthree\n");
    await manager.commit(one, "one", "w1");
    await manager.commit(two, "two", "w2");
    expect(await manager.integrate("run-x-cccc3333", "one", base, "w1")).toMatchObject({
      status: "merged",
    });
    const integration = await manager.integration("run-x-cccc3333", base);
    const tip = git(integration.path, "rev-parse", "HEAD");
    expect(await manager.integrate("run-x-cccc3333", "two", base, "w2")).toEqual({
      status: "conflict",
      files: ["a.txt"],
    });
    expect(git(integration.path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(integration.path, "status", "--porcelain")).toBe("");
  });

  it("does not merge twice when the merge happened before a crash", async () => {
    const base = await manager.head();
    const task = await manager.prepare("run-x-dddd4444", "t", base);
    writeFileSync(join(task.path, "b.txt"), "b\n");
    await manager.commit(task, "b", "w");
    await manager.integrate("run-x-dddd4444", "t", base, "w");
    const integration = manager.integrationBranch("run-x-dddd4444");
    const commits = git(repo, "rev-list", "--count", integration);
    expect(await manager.merged("run-x-dddd4444", "t")).toBe(true);
    expect(await manager.integrate("run-x-dddd4444", "t", base, "w")).toMatchObject({
      status: "merged",
    });
    expect(git(repo, "rev-list", "--count", integration)).toBe(commits);
  });

  it("reuses a task's worktree after a restart, and says when a task changed nothing", async () => {
    const base = await manager.head();
    const first = await manager.prepare("run-x-eeee5555", "same", base);
    writeFileSync(join(first.path, "wip.txt"), "work in progress\n");
    const again = await manager.prepare("run-x-eeee5555", "same", base);
    expect(again.path).toBe(first.path);
    expect(readFileSync(join(again.path, "wip.txt"), "utf8")).toBe("work in progress\n");
    const idle = await manager.prepare("run-x-eeee5555", "idle", base);
    expect(await manager.commit(idle, "nothing", "w")).toBeUndefined();
    expect(await manager.integrate("run-x-eeee5555", "idle", base, "w")).toMatchObject({
      status: "nothing",
    });
  });

  it("removes a worktree only when nothing would be lost", async () => {
    const base = await manager.head();
    const dirty = await manager.prepare("run-x-ffff6666", "dirty", base);
    writeFileSync(join(dirty.path, "loose.txt"), "not committed\n");
    expect(await manager.remove("run-x-ffff6666", "dirty")).toMatch(/not committed/);
    const unmerged = await manager.prepare("run-x-ffff6666", "unmerged", base);
    writeFileSync(join(unmerged.path, "u.txt"), "u\n");
    await manager.commit(unmerged, "u", "w");
    await manager.integration("run-x-ffff6666", base);
    expect(await manager.remove("run-x-ffff6666", "unmerged")).toMatch(/not merged/);
    const done = await manager.prepare("run-x-ffff6666", "done", base);
    writeFileSync(join(done.path, "d.txt"), "d\n");
    await manager.commit(done, "d", "w");
    await manager.integrate("run-x-ffff6666", "done", base, "w");
    expect(await manager.remove("run-x-ffff6666", "done")).toBeUndefined();
    expect(existsSync(done.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    // The branch stays for the user.
    expect(git(repo, "branch", "--list", "grafeno/ffff6666/done")).toContain(
      "grafeno/ffff6666/done",
    );
  });
});

function spec(id: string, touches: string[], extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: id,
    kind: "backend",
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches,
    acceptance: [{ check: "files", exist: touches }],
    parallelSafe: true,
    ...extra,
  };
}

describe("the pipeline with the scheduler", () => {
  /** A worker that writes the files its task names, with the given text, in its own workspace. */
  function writer(text: (id: string) => string) {
    return (
      workspaceFor: Parameters<ConstructorParameters<typeof TaskPipeline>[0]["inner"]>[0],
    ): TaskRunner => ({
      async run(task, context): Promise<AttemptOutcome> {
        const workspace = await workspaceFor(task, context);
        context.assign({ worker: `worker-${task.id}` });
        for (const file of task.spec.touches)
          writeFileSync(join(workspace.root, file), text(task.id));
        return { status: "completed", summary: `wrote ${task.spec.touches.join(", ")}` };
      },
    });
  }

  it("runs tasks in their own worktrees and merges them all into the integration branch", async () => {
    const store = new SqliteStore();
    const tasks = [spec("api", ["api.ts"]), spec("ui", ["ui.tsx"]), spec("docs", ["guide.md"])];
    const plan: Plan = { goal: "g", risks: [], tasks };
    const run = store.createRun("r", plan, ["api", "ui", "docs"], await manager.head());
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees: manager,
      inner: writer((id) => `${id}\n`),
    });
    expect(await new Scheduler({ store, runner: pipeline, maxWorkers: 3 }).run(run.id)).toBe(
      "completed",
    );
    const integration = manager.integrationBranch(run.id);
    for (const file of ["api.ts", "ui.tsx", "guide.md"]) {
      expect(git(repo, "show", `${integration}:${file}`)).not.toBe("");
    }
    expect(store.events(run.id).filter((e) => e.kind === "merged")).toHaveLength(3);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(await pipeline.finish(run.id)).toEqual([]);
    expect(existsSync(manager.pathFor(run.id, "api"))).toBe(false);
  });

  it("sends a task whose merge conflicts to review, with the files", async () => {
    const store = new SqliteStore();
    // Both change a.txt, one after the other (the second depends on nothing, but they
    // run one at a time because they touch the same file).
    const tasks = [spec("first", ["a.txt"]), spec("second", ["a.txt"])];
    const run = store.createRun(
      "r",
      { goal: "g", risks: [], tasks },
      ["first", "second"],
      await manager.head(),
    );
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees: manager,
      inner: writer((id) => `${id}\n`),
    });
    expect(await new Scheduler({ store, runner: pipeline }).run(run.id)).toBe("waiting");
    expect(store.task(run.id, "first")?.state).toBe("completed");
    expect(store.task(run.id, "second")).toMatchObject({ state: "review" });
    expect(store.task(run.id, "second")?.reason).toContain("conflicts in a.txt");
  });

  it("works in the project's folder when it is not a git repository", async () => {
    const plain = join(dir, "plain");
    execFileSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(plain)})`]);
    const store = new SqliteStore();
    const run = store.createRun("r", { goal: "g", risks: [], tasks: [spec("x", ["x.txt"])] }, [
      "x",
    ]);
    const pipeline = new TaskPipeline({
      store,
      projectRoot: plain,
      worktrees: new WorktreeManager({ repo: plain, root: join(dir, "wt2") }),
      inner: writer(() => "x\n"),
    });
    expect(await new Scheduler({ store, runner: pipeline }).run(run.id)).toBe("completed");
    expect(readFileSync(join(plain, "x.txt"), "utf8")).toBe("x\n");
  });
});
