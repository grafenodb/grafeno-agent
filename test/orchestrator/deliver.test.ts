import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { deliver, describeDelivery, type DeliveryChecks } from "../../src/orchestrator/deliver.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import type { Autonomy } from "../../src/orchestrator/policy.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { WorktreeManager } from "../../src/orchestrator/worktrees.js";
import type { Provider } from "../../src/providers/types.js";

let dir: string;
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-deliver-"));
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

function spec(id: string): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${id}.txt.`,
    kind: "backend",
    dependsOn: [],
    complexity: 1,
    capabilities: ["code"],
    touches: [`${id}.txt`],
    acceptance: [{ check: "files", exist: [`${id}.txt`] }],
    parallelSafe: true,
  };
}

const PLAN: Plan = { goal: "Write the api", risks: [], tasks: [spec("api")] };
const pass: DeliveryChecks = () => Promise.resolve({ ok: true, diagnostic: "" });
const fail: DeliveryChecks = () =>
  Promise.resolve({ ok: false, diagnostic: "- `npm test` exited 1" });

/** A run whose integration branch holds `api.txt`, as a finished run leaves it. */
async function finishedRun(file = "api.txt", content = "api\n") {
  const store = new SqliteStore();
  const worktrees = new WorktreeManager({ repo, root: join(dir, "worktrees") });
  const base = await worktrees.head();
  const run = store.createRun("Write the api", PLAN, ["api"], base);
  const integration = await worktrees.integration(run.id, base);
  writeFileSync(join(integration.path, file), content);
  await worktrees.commit(integration, "Write the api", "w1");
  return { store, worktrees, runId: run.id, base };
}

describe("delivery into the user's branch (phase D6)", { timeout: 30_000 }, () => {
  it("merges with a rollback ref and the run's origin, checks the result, and never pushes", async () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote], { windowsHide: true });
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    const { store, worktrees, runId, base } = await finishedRun();
    let checkedIn = "";
    const result = await deliver({
      store,
      worktrees,
      runId,
      checks: (root) => {
        checkedIn = root;
        // The checks see the merged work in the user's tree.
        return Promise.resolve({ ok: existsSync(join(root, "api.txt")), diagnostic: "" });
      },
    });
    expect(result).toMatchObject({ status: "merged", branch: "main" });
    expect(checkedIn).toBe(worktrees.repo);
    expect(readFileSync(join(repo, "api.txt"), "utf8")).toBe("api\n");
    // Where main was is kept, and the merge says where it came from.
    expect(git("rev-parse", worktrees.rollbackRef(runId))).toBe(base);
    const message = git("log", "-1", "--format=%B");
    expect(message).toContain(`Grafeno-Run: ${runId}`);
    expect(message).toContain(`Grafeno-Branch: ${worktrees.integrationBranch(runId)}`);
    expect(git("log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    // Recorded, done, and nothing pushed.
    const kinds = store.events(runId).map((e) => e.kind);
    expect(kinds).toContain("merged_user");
    expect(store.events(runId).find((e) => e.kind === "delivery")?.data.status).toBe("merged");
    expect(store.effectsInFlight(runId)).toEqual([]);
    expect(git("rev-parse", "origin/main")).toBe(base);
    expect(git("ls-remote", "origin", "main").split(/\s/)[0]).toBe(base);
    // A second time is nothing new.
    expect(await deliver({ store, worktrees, runId, checks: pass })).toMatchObject({
      status: "already",
    });
  });

  it("undoes the merge when a check fails, back to where the branch was", async () => {
    const { store, worktrees, runId, base } = await finishedRun();
    const result = await deliver({ store, worktrees, runId, checks: fail });
    expect(result.status).toBe("undone");
    expect(result.status === "undone" && result.reason).toContain("`npm test` exited 1");
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(repo, "api.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
    expect(store.effectsInFlight(runId)).toEqual([]);
  });

  it("does not undo over a change made meanwhile; says how instead", async () => {
    const { store, worktrees, runId } = await finishedRun();
    const result = await deliver({
      store,
      worktrees,
      runId,
      checks: () => {
        // The user commits while the checks run.
        writeFileSync(join(repo, "NOTES.md"), "mine\n");
        git("add", "NOTES.md");
        git("commit", "-q", "-m", "my notes");
        return Promise.resolve({ ok: false, diagnostic: "failed" });
      },
    });
    expect(result.status).toBe("kept");
    expect(result.status === "kept" && result.reason).toContain(
      `git reset --keep ${worktrees.rollbackRef(runId)}`,
    );
    expect(git("log", "-1", "--format=%s")).toBe("my notes");
  });

  it("leaves a dirty tree, a detached HEAD and an empty run alone", async () => {
    const dirty = await finishedRun();
    writeFileSync(join(repo, "scratch.txt"), "untracked\n");
    const skipped = await deliver({ ...dirty, checks: pass });
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped.status === "skipped" && skipped.reason).toContain("1 file not committed");
    expect(git("rev-parse", "HEAD")).toBe(dirty.base);
    rmSync(join(repo, "scratch.txt"));

    git("checkout", "-q", "--detach");
    expect(await deliver({ ...dirty, checks: pass })).toMatchObject({
      status: "skipped",
      reason: "HEAD is detached, not on a branch",
    });
    git("checkout", "-q", "main");

    const store = new SqliteStore();
    const worktrees = new WorktreeManager({ repo, root: join(dir, "w2") });
    const run = store.createRun("nothing", PLAN, ["api"], dirty.base);
    expect(await deliver({ store, worktrees, runId: run.id, checks: pass })).toEqual({
      status: "skipped",
      reason: "the run changed nothing",
    });
  });

  it("leaves the branch as it was on a conflict", async () => {
    const run = await finishedRun("README.md", "# Theirs\n");
    writeFileSync(join(repo, "README.md"), "# Mine\n");
    git("commit", "-q", "-am", "mine");
    const head = git("rev-parse", "HEAD");
    const result = await deliver({ ...run, checks: pass });
    expect(result).toMatchObject({ status: "conflict", files: ["README.md"] });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe("");
    expect(describeDelivery(result, "x").join("\n")).toContain("conflicts in README.md");
  });

  it("checks a merge a crash left unchecked, and undoes it if it fails", async () => {
    const { store, worktrees, runId, base } = await finishedRun();
    // As a crash leaves it: merged and recorded, the effect still in flight.
    store.beginEffect(`merge-user:${runId}`, runId, "merge-user", {});
    const merge = await worktrees.mergeIntoCurrent(runId, "Merge");
    if (merge.status !== "merged") throw new Error("expected a merge");
    store.event(runId, "merged_user", { commit: merge.commit });
    expect(await deliver({ store, worktrees, runId, checks: fail })).toMatchObject({
      status: "undone",
    });
    expect(git("rev-parse", "HEAD")).toBe(base);
  });
});

/** A provider whose planner plans one task and whose worker writes its file. */
function provider(): Provider {
  const plan = {
    ...PLAN,
    tasks: [{ ...spec("api"), recommended: { tier: "light", effort: "low" } }],
  };
  const turn: FakeTurn = (context) =>
    context.system.includes("You are the planner") ||
    context.message.includes("Turn the user's request")
      ? [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }]
      : [{ call: "write_file", input: { path: "api.txt", content: "api\n" } }, { say: "Done." }];
  return {
    id: "fake",
    name: "Fake",
    signIn: "",
    tiers: { deep: ["big"], standard: ["mid"], light: ["small"] },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () => Promise.resolve([{ id: "small", name: "Small" }]),
    efforts: () => ["low"],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: () => new FakeModel({ turns: [turn] }),
  };
}

async function runIn(mode: Autonomy) {
  const orchestrator = new Orchestrator({
    provider: provider(),
    project: { name: "shop", path: repo },
    projectRoot: repo,
    dataDir: join(dir, "data"),
    metrics: false,
    mode,
  });
  try {
    const planned = await orchestrator.plan("Write the api");
    const { run } = await orchestrator.start("Write the api", planned);
    const state = await orchestrator.run(run.id);
    return { state, delivery: orchestrator.delivery(run.id), runId: run.id };
  } finally {
    orchestrator.close();
  }
}

describe("a run and the user's branch", { timeout: 60_000 }, () => {
  it("in extended, ends with the work merged into the user's branch", async () => {
    const before = git("rev-parse", "HEAD");
    const { state, delivery } = await runIn("extended");
    expect(state).toBe("completed");
    expect(delivery).toMatchObject({ status: "merged", branch: "main" });
    expect(readFileSync(join(repo, "api.txt"), "utf8")).toBe("api\n");
    expect(git("rev-parse", "HEAD^1")).toBe(before);
  });

  it("in controlled, leaves the user's branch alone: the user merges", async () => {
    const before = git("rev-parse", "HEAD");
    const { state, delivery } = await runIn("controlled");
    expect(state).toBe("completed");
    expect(delivery).toBeUndefined();
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(repo, "api.txt"))).toBe(false);
  });
});
