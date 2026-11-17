import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import {
  checkDoubt,
  judgeChecks,
  MAX_CHECK_REPAIRS,
  readJudgement,
  trivialCheck,
  type CheckJudgement,
} from "../../src/orchestrator/checks-repair.js";
import { TaskPipeline } from "../../src/orchestrator/pipeline.js";
import type { Acceptance, Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { describeResult } from "../../src/orchestrator/result.js";
import {
  Scheduler,
  type AttemptOutcome,
  type TaskRunner,
} from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { verifier, type CommandRunner } from "../../src/orchestrator/verify.js";
import { WorktreeManager } from "../../src/orchestrator/worktrees.js";

const BROKEN = "cat greeting.txt | grep -q hello && wc -c < greeting.txt | awk '{print $1}' == 5";
const AWK_ERROR = "awk: fatal: cannot open file `==' for reading: No such file or directory";
const LINES = "test $(wc -l < NOTES.md) -eq 1";
const FIXED = "grep -qx hello greeting.txt";

function spec(id: string, acceptance: Acceptance[]): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: "Create greeting.txt with the word hello",
    kind: "docs",
    dependsOn: [],
    complexity: 1,
    capabilities: ["code"],
    touches: ["greeting.txt"],
    acceptance,
    parallelSafe: true,
  };
}

/** Commands answered from a table (anything else exits 0). */
function runner(answers: Record<string, { code: number; output: string }>): CommandRunner {
  return {
    run: (command) =>
      Promise.resolve({ timedOut: false, ...(answers[command] ?? { code: 0, output: "" }) }),
  };
}

describe("which failures are judged", () => {
  it("a check whose own command broke, or the same failure again after the diagnostic", () => {
    const broken = `These checks failed; fix the work so that they pass:\n- \`${BROKEN}\` exited 2:\n${AWK_ERROR}`;
    expect(checkDoubt(broken, undefined)).toBe("broken");
    const lines = `These checks failed; fix the work so that they pass:\n- \`${LINES}\` exited 1:\n`;
    expect(checkDoubt(lines, undefined)).toBeUndefined();
    expect(checkDoubt(lines, lines)).toBe("disputed");
    expect(checkDoubt(lines, "- `npm test` exited 1: 2 failed")).toBeUndefined();
  });

  it("commands that pass whatever the work is are not checks", () => {
    for (const run of ["true", ":", "exit 0", "echo ok", "printf done"]) {
      expect(trivialCheck(run)).toBe(true);
    }
    for (const run of [FIXED, "npm test", "echo hello | diff - greeting.txt"]) {
      expect(trivialCheck(run)).toBe(false);
    }
  });
});

describe("the judge's answer", () => {
  const task = { id: "t" };

  it("corrected checks, read with the plan's rules", () => {
    const answer = readJudgement(
      JSON.stringify({
        verdict: "check",
        why: "awk was given == as a file",
        acceptance: [
          { check: "command", run: FIXED },
          { check: "files", exist: ["greeting.txt"] },
        ],
      }),
      task,
    );
    expect(answer).toEqual({
      verdict: "check",
      why: "awk was given == as a file",
      acceptance: [
        { check: "command", run: FIXED },
        { check: "files", exist: ["greeting.txt"] },
      ],
    });
    expect(
      readJudgement('```json\n{"verdict":"work","why":"the file is empty"}\n```', task),
    ).toEqual({ verdict: "work", why: "the file is empty" });
  });

  it("reads checks in the shapes a small model writes them, with the same rules", () => {
    // What gemma-4-e4b answered, in a real run, for the broken awk check.
    const real = readJudgement(
      JSON.stringify({
        verdict: "check",
        why: "awk read == as a file",
        acceptance: [
          { check: "grep -q 'hello' greeting.txt" },
          { check: "wc -l < greeting.txt | grep -q '^1$' " },
        ],
      }),
      task,
    );
    expect(real).toMatchObject({
      verdict: "check",
      acceptance: [
        { check: "command", run: "grep -q 'hello' greeting.txt" },
        { check: "command", run: "wc -l < greeting.txt | grep -q '^1$'" },
      ],
    });
    const of = (acceptance: unknown[]) =>
      readJudgement(JSON.stringify({ verdict: "check", why: "w", acceptance }), task);
    expect(of(["test -f NOTES.md", { command: "grep -q x NOTES.md" }])).toMatchObject({
      acceptance: [
        { check: "command", run: "test -f NOTES.md" },
        { check: "command", run: "grep -q x NOTES.md" },
      ],
    });
    // Also seen: the command where the kind goes, and `run` empty.
    expect(of([{ check: "test -f NOTES.md", run: "" }])).toMatchObject({
      acceptance: [{ check: "command", run: "test -f NOTES.md" }],
    });
    expect(of([{ check: "true" }]).verdict).toBe("none");
    expect(of(["rm -rf /"]).verdict).toBe("none");
  });

  it("refuses corrections that check nothing, pass anything, or are forbidden", () => {
    const of = (acceptance: unknown[]) =>
      readJudgement(JSON.stringify({ verdict: "check", why: "w", acceptance }), task);
    expect(of([{ check: "review", criteria: "reads well" }]).verdict).toBe("none");
    expect(of([{ check: "command", run: "true" }])).toMatchObject({
      verdict: "none",
      reason: '"true" passes whatever the work is',
    });
    expect(of([{ check: "command", run: "rm -rf /" }]).verdict).toBe("none");
    expect(readJudgement("I think the check is wrong", task).verdict).toBe("none");
    expect(readJudgement('{"verdict":"maybe"}', task).verdict).toBe("none");
  });

  it("is asked with the checks, what they said and the change", async () => {
    const model = new FakeModel({
      turns: [
        [
          {
            say: JSON.stringify({
              verdict: "check",
              why: "w",
              acceptance: [{ check: "command", run: FIXED }],
            }),
          },
        ],
      ],
    });
    const judged = await judgeChecks(
      model,
      spec("t", [{ check: "command", run: BROKEN }]),
      "broken",
      `- \`${BROKEN}\` exited 2:\n${AWK_ERROR}`,
      "+hello",
    );
    expect(judged.verdict).toBe("check");
    const sent = model.conversations[0]?.messages[0] ?? "";
    expect(sent).toContain(BROKEN);
    expect(sent).toContain(AWK_ERROR);
    expect(sent).toContain("+hello");
    expect(sent).toContain("its output shows an error of the command");
  });

  it("a judge that cannot be asked leaves the checks as they are", async () => {
    const model = new FakeModel({ turns: [[{ fail: "failed", message: "no server" }]] });
    const judged = await judgeChecks(model, spec("t", []), "broken", "d", "");
    expect(judged.verdict).toBe("none");
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-checks-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a just-used folder for a moment.
  }
});

// Real worktrees, commits and merges: git on Windows is slow to start.
describe("checks judged in a run", { timeout: 30_000 }, () => {
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

  /** A worker that writes greeting.txt as asked (with no final newline), every attempt. */
  const writer = (
    workspaceFor: Parameters<ConstructorParameters<typeof TaskPipeline>[0]["inner"]>[0],
  ): TaskRunner => ({
    async run(task, context): Promise<AttemptOutcome> {
      const workspace = await workspaceFor(task, context);
      writeFileSync(join(workspace.root, "greeting.txt"), "hello");
      return { status: "completed", summary: "wrote it" };
    },
  });

  async function setUp(acceptance: Acceptance[]) {
    const repo = gitRepo();
    const worktrees = new WorktreeManager({ repo, root: join(dir, "wt") });
    const store = new SqliteStore();
    const plan: Plan = { goal: "g", risks: [], tasks: [spec("greet", acceptance)] };
    const run = store.createRun("r", plan, ["greet"], await worktrees.head());
    return { repo, worktrees, store, run };
  }

  function judgeWith(answer: CheckJudgement) {
    const asked: { doubt: string; diff: string }[] = [];
    return {
      asked,
      judge: (_task: unknown, doubt: string, _diagnostic: string, diff: string) => {
        asked.push({ doubt, diff });
        return Promise.resolve({ judgement: answer, judge: "lmstudio/gemma" });
      },
    };
  }

  it("a broken check is corrected and run on the same work: no attempt is spent on it", async () => {
    const { repo, worktrees, store, run } = await setUp([{ check: "command", run: BROKEN }]);
    const { judge, asked } = judgeWith({
      verdict: "check",
      why: "awk read == as a file",
      acceptance: [{ check: "command", run: FIXED }],
    });
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner: writer,
      verify: verifier({ runner: runner({ [BROKEN]: { code: 2, output: AWK_ERROR } }) }),
      judgeChecks: judge,
    });
    expect(await new Scheduler({ store, runner: pipeline, maxAttempts: 3 }).run(run.id)).toBe(
      "completed",
    );
    expect(store.task(run.id, "greet")?.attempts).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.doubt).toBe("broken");
    expect(asked[0]?.diff).toContain("+hello");
    expect(store.task(run.id, "greet")?.spec.acceptance).toEqual([
      { check: "command", run: FIXED },
    ]);
    const repaired = store.events(run.id).find((e) => e.kind === "checks_repaired");
    expect(repaired?.data).toMatchObject({
      doubt: "broken",
      judge: "lmstudio/gemma",
      before: [BROKEN],
      after: [FIXED],
    });
    expect(
      store
        .events(run.id)
        .filter((e) => e.kind === "verified")
        .map((e) => e.data.ok),
    ).toEqual([true]);
    const result = describeResult(store.tasks(run.id), store.events(run.id), "completed");
    expect(result.tasks[0]).toContain("checks corrected by lmstudio/gemma");
  });

  it("a check that fails the same way twice is judged; when the work is wrong, the checks stand", async () => {
    const { repo, worktrees, store, run } = await setUp([{ check: "command", run: LINES }]);
    const { judge, asked } = judgeWith({ verdict: "work", why: "the file must end in a newline" });
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner: writer,
      verify: verifier({ runner: runner({ [LINES]: { code: 1, output: "" } }) }),
      judgeChecks: judge,
    });
    expect(await new Scheduler({ store, runner: pipeline, maxAttempts: 4 }).run(run.id)).toBe(
      "failed",
    );
    // Not on the first failure: only once the worker had the diagnostic.
    expect(asked.map((a) => a.doubt)).toEqual(
      Array.from({ length: MAX_CHECK_REPAIRS }, () => "disputed"),
    );
    expect(store.task(run.id, "greet")?.spec.acceptance).toEqual([
      { check: "command", run: LINES },
    ]);
    expect(store.events(run.id).filter((e) => e.kind === "checks_judged")).toHaveLength(
      MAX_CHECK_REPAIRS,
    );
    expect(describeResult(store.tasks(run.id), store.events(run.id), "failed").tasks[0]).toContain(
      `check failed: \`${LINES}\` exited 1`,
    );
  });

  it("an ordinary failed check goes back to the worker without asking anyone", async () => {
    const { repo, worktrees, store, run } = await setUp([{ check: "command", run: "npm test" }]);
    const { judge, asked } = judgeWith({ verdict: "work", why: "w" });
    let calls = 0;
    const pipeline = new TaskPipeline({
      store,
      projectRoot: repo,
      worktrees,
      inner: writer,
      verify: verifier({
        runner: {
          run: () => {
            calls++;
            return Promise.resolve({
              timedOut: false,
              code: calls === 1 ? 1 : 0,
              output: calls === 1 ? "1 test failed" : "ok",
            });
          },
        },
      }),
      judgeChecks: judge,
    });
    expect(await new Scheduler({ store, runner: pipeline, maxAttempts: 3 }).run(run.id)).toBe(
      "completed",
    );
    expect(asked).toHaveLength(0);
    expect(store.task(run.id, "greet")?.attempts).toBe(2);
  });
});
