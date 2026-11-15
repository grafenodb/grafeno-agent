import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import { crossReview, readReview, REVIEW_SYSTEM } from "../../src/orchestrator/review.js";
import type { Provider } from "../../src/providers/types.js";

const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function spec(id: string, kind: TaskSpec["kind"] = "backend"): TaskSpec {
  return {
    id,
    title: `Write ${id}`,
    description: `Create ${id}.txt.`,
    kind,
    dependsOn: [],
    complexity: 2,
    capabilities: ["code"],
    touches: [`${id}.txt`],
    acceptance: [{ check: "files", exist: [`${id}.txt`] }],
    parallelSafe: true,
  };
}

describe("readReview", () => {
  it("reads ok and changes strictly; anything else is no verdict", () => {
    expect(readReview(json({ verdict: "ok" }))).toEqual({ verdict: "ok" });
    expect(
      readReview(
        json({
          verdict: "changes",
          issues: [{ file: "a.ts", issue: "No input check", fix: "Validate it" }],
        }),
      ),
    ).toEqual({
      verdict: "changes",
      issues: [{ file: "a.ts", issue: "No input check", fix: "Validate it" }],
    });
    // "Changes" with nothing concrete is no finding.
    expect(readReview(json({ verdict: "changes", issues: [{ issue: " " }] }))).toEqual({
      verdict: "ok",
    });
    expect(readReview("Looks great!").verdict).toBe("none");
    expect(readReview(json({ verdict: "approved" })).verdict).toBe("none");
  });
});

describe("crossReview", () => {
  it("gives the reviewer the task, its acceptance and the diff, with no tools", async () => {
    const model = new FakeModel({ turns: [[{ say: json({ verdict: "ok" }) }]] });
    expect(await crossReview(model, spec("api"), "+export const x = 1;\n")).toEqual({
      verdict: "ok",
    });
    expect(model.conversations[0]?.system).toBe(REVIEW_SYSTEM);
    const message = model.conversations[0]?.messages[0] ?? "";
    expect(message).toContain('Task "Write api" (backend)');
    expect(message).toContain("these files exist: api.txt");
    expect(message).toContain("<diff>\n+export const x = 1;");
  });

  it("skips what changed nothing, and a reviewer that fails is no verdict, never a gate", async () => {
    const model = new FakeModel({ turns: [[{ fail: "unavailable", message: "down" }]] });
    expect((await crossReview(model, spec("api"), "")).verdict).toBe("none");
    const failed = await crossReview(model, spec("api"), "+x\n");
    expect(failed).toMatchObject({ verdict: "none" });
  });
});

describe("cross review in a run", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-review-"));
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

  /** Workers write their file ("fixed" once told of a review); the reviewer answers from `reviews`. */
  function provider(reviews: string[], seen: string[]): Provider {
    let reviewed = 0;
    const turn: FakeTurn = (c) => {
      if (c.system.includes("You review a change")) {
        seen.push(c.message);
        return [
          { say: reviews[Math.min(reviewed++, reviews.length - 1)] ?? json({ verdict: "ok" }) },
        ];
      }
      const file = /these files exist: (\S+)/.exec(c.message)?.[1] ?? "x.txt";
      const fixed = c.message.includes("A reviewer");
      return [
        {
          call: "write_file",
          input: { path: file, content: fixed ? "validated\n" : "first try\n" },
        },
        { say: "Done." },
      ];
    };
    return {
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
      create: () => new FakeModel({ turns: [turn] }),
    };
  }

  async function runOne(
    task: TaskSpec,
    reviews: string[],
    review: ConstructorParameters<typeof Orchestrator>[0]["review"],
  ) {
    const seen: string[] = [];
    const orchestrator = new Orchestrator({
      provider: provider(reviews, seen),
      project: { name: "shop", path: repo },
      projectRoot: repo,
      dataDir: join(dir, "data"),
      metrics: false,
      ...(review === undefined ? {} : { review }),
    });
    const run = orchestrator.store.createRun("one", { goal: "g", risks: [], tasks: [task] }, [
      task.id,
    ]);
    const state = await orchestrator.run(run.id);
    return { orchestrator, run, state, seen };
  }

  it("sends a task back with the reviewer's issues, then merges what the checks and the review let through", async () => {
    const issue = json({
      verdict: "changes",
      issues: [{ file: "api.txt", issue: "No validation", fix: "Validate" }],
    });
    const { orchestrator, run, state, seen } = await runOne(
      spec("api"),
      [issue, json({ verdict: "ok" })],
      true,
    );
    expect(state).toBe("completed");
    expect(orchestrator.store.task(run.id, "api")?.attempts).toBe(2);
    const reviews = orchestrator.store.events(run.id).filter((e) => e.kind === "reviewed");
    expect(reviews.map((e) => [e.data.verdict, e.data.round, e.data.reviewer])).toEqual([
      ["changes", 1, "fake/mid"],
      ["ok", 2, "fake/mid"],
    ]);
    // The reviewer is independent: a review task's model (standard), the backend worker's deep.
    expect(reviews[0]?.data.independent).toBe(true);
    expect(seen[1]).toContain("+validated");
    expect(git("show", `${orchestrator.integrationBranch(run.id)}:api.txt`)).toBe("validated");
    orchestrator.close();
  });

  it("gives a disagreement left after the rounds to a person, and merges nothing", async () => {
    const issue = json({ verdict: "changes", issues: [{ issue: "Still wrong" }] });
    const { orchestrator, run, state } = await runOne(spec("api"), [issue], { rounds: 1 });
    expect(state).toBe("waiting");
    const task = orchestrator.store.task(run.id, "api");
    expect(task?.state).toBe("review");
    expect(task?.reason).toMatch(/still asks for changes after 2 rounds; a person decides/);
    expect(orchestrator.store.events(run.id).some((e) => e.kind === "merged")).toBe(false);
    orchestrator.close();
  });

  it("goes on when the reviewer gives no verdict: a review is evidence, not a gate", async () => {
    const { orchestrator, run, state } = await runOne(spec("api"), ["I like it."], true);
    expect(state).toBe("completed");
    expect(
      orchestrator.store.events(run.id).find((e) => e.kind === "review_skipped")?.data.reason,
    ).toMatch(/no JSON/);
    orchestrator.close();
  });

  it("reviews nothing without --review, and no docs by default", async () => {
    const off = await runOne(spec("api"), [], undefined);
    expect(off.seen).toEqual([]);
    off.orchestrator.close();
    const docs = await runOne(spec("guide", "docs"), [], true);
    expect(docs.seen).toEqual([]);
    expect(docs.state).toBe("completed");
    docs.orchestrator.close();
  });
});
