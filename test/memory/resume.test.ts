import { describe, expect, it } from "vitest";
import { packCheckpoint } from "../../src/memory/checkpoint.js";
import { compactResume, estimateTokens } from "../../src/memory/resume.js";
import type { VaultAnswer } from "../../src/memory/vault.js";
import { FakeVault } from "./fake-vault.js";

const ok = (data: unknown): VaultAnswer => ({ text: JSON.stringify(data), isError: false, data });

/** A checkpoint as Grafeno's `resume` returns it. */
function saved(input: Parameters<typeof packCheckpoint>[0], extra: Record<string, unknown> = {}) {
  return ok({
    found: true,
    checkpoint: { ...packCheckpoint(input), id: "cp1", at: 1794718104985797, ...extra },
  });
}

const STATE = {
  task: "parser",
  goal: "Parse the config language",
  summary: "Lexer done; the parser waits on the grammar.",
  next_action: "Write the expression grammar",
  next: ["Error messages"],
  done: ["Lexer", "Tokens"],
  decisions: ["Hand-written parser, no generator"],
  files: ["src/parser.ts"],
  errors: ["test/lexer.test.ts: 1 failing"],
};

function memory(id: string, text: string, labels = ["Fact"], name?: string) {
  return { id, text: name ? `${name}: ${text}` : text, labels, ...(name ? { name } : {}) };
}

describe("compactResume", () => {
  it("brings the checkpoint and a few related memories, in two calls", async () => {
    const vault = new FakeVault({
      resume: () => saved(STATE),
      recall: () =>
        ok({
          results: [
            memory("m1", "Precedence follows C, the user said.", ["Decision"], "Precedence"),
            memory("m2", "The lexer keeps comments as trivia."),
          ],
        }),
    });
    const resumed = await compactResume({ vault, about: "project" });
    expect(resumed.stats.calls).toBe(2);
    expect(vault.called("recall")[0]).toMatchObject({
      query: "Parse the config language — Write the expression grammar — parser",
      depth: 0,
    });
    expect(resumed.text).toContain("Task: parser — Parse the config language [in_progress]");
    expect(resumed.text).toContain("Next: Write the expression grammar");
    expect(resumed.text).toContain("Open errors: test/lexer.test.ts: 1 failing");
    expect(resumed.text).toContain("- Precedence [m1]: Precedence follows C, the user said.");
    expect(resumed.memories.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(resumed.more).toEqual([]);
    expect(resumed.stats.totalTokens).toBeLessThanOrEqual(1000);
  });

  it("stays within budget with thousands of memories, and lists the rest by id", async () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      memory(
        `m${String(i)}`,
        `Fact number ${String(i)} about the parser: ${"detail ".repeat(i % 30)}`,
      ),
    );
    const vault = new FakeVault({
      resume: () => saved(STATE),
      // Grafeno honours the limit it is asked for.
      recall: (args) => ok({ results: many.slice(0, Number(args.limit)) }),
    });
    const resumed = await compactResume({ vault, about: "p", memoryBudget: 120, maxMemories: 5 });
    expect(vault.called("recall")[0]?.limit).toBe(15);
    expect(resumed.stats.memoryTokens).toBeLessThanOrEqual(120);
    expect(resumed.memories.length).toBeGreaterThan(0);
    expect(resumed.memories.length + resumed.more.length).toBe(15);
    expect(resumed.text).toMatch(
      /More in memory, not loaded \(get_node or recall when needed\): m/,
    );
  });

  it("leaves out checkpoints, the project node and repeats of what the checkpoint says", async () => {
    const vault = new FakeVault({
      resume: () => saved(STATE),
      recall: () =>
        ok({
          results: [
            memory("c0", "Checkpoint of parser: ...", ["Checkpoint"]),
            memory("p0", "The project.", ["Project"]),
            memory("d1", "Hand-written parser, no generator", ["Decision"]),
            memory("m1", "Comments are kept as trivia by the lexer."),
            memory("m2", "Comments are kept as trivia by the lexer!"),
          ],
        }),
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.memories.map((m) => m.id)).toEqual(["m1"]);
    expect(resumed.stats.itemsDeduplicated).toBe(2);
  });

  it("keeps the next action, blocks and errors under a tiny budget, and says what was cut", async () => {
    const vault = new FakeVault({
      resume: () =>
        saved({
          ...STATE,
          status: "blocked",
          blocked: ["Grammar: waits on the user's choice"],
          decisions: Array.from(
            { length: 40 },
            (_, i) => `Decision ${String(i)}: ${"why ".repeat(10)}`,
          ),
          done: Array.from({ length: 40 }, (_, i) => `Step ${String(i)}`),
        }),
      recall: () => ok({ results: [] }),
    });
    const resumed = await compactResume({ vault, about: "p", checkpointBudget: 120 });
    expect(resumed.text).toContain("[blocked]");
    expect(resumed.text).toContain("Next: Write the expression grammar");
    expect(resumed.text).toContain("Blocked: Grammar: waits on the user's choice");
    expect(resumed.text).toContain("Open errors: test/lexer.test.ts: 1 failing");
    expect(resumed.stats.checkpointItemsCut).toBeGreaterThan(0);
    expect(resumed.text).toMatch(/more in the checkpoint|\(in the checkpoint\)/);
  });

  it("puts the memories the checkpoint points at first, and lists the ones not found", async () => {
    const vault = new FakeVault({
      resume: () => saved({ ...STATE, memory_refs: ["m2", "gone"] }),
      recall: () => ok({ results: [memory("m1", "First by score."), memory("m2", "Pointed at.")] }),
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.memories.map((m) => m.id)).toEqual(["m2", "m1"]);
    expect(resumed.more.map((m) => m.id)).toEqual(["gone"]);
  });

  it("says when there is no checkpoint yet, and looks nothing up", async () => {
    const vault = new FakeVault();
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.text).toContain("first session");
    expect(vault.called("recall")).toEqual([]);
  });

  it("says plainly when memory cannot be reached", async () => {
    const vault = new FakeVault({
      resume: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:7810");
      },
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.unavailable).toContain("ECONNREFUSED");
    expect(resumed.text).toContain("Memory could not be reached");
  });

  it("goes on with the checkpoint when the memory search fails", async () => {
    const vault = new FakeVault({
      resume: () => saved(STATE),
      recall: () => ({ text: "search failed", isError: true }),
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.text).toContain("Next: Write the expression grammar");
    expect(resumed.memories).toEqual([]);
  });

  it("restores an interrupted task from an older-format checkpoint", async () => {
    const vault = new FakeVault({
      resume: () =>
        ok({
          found: true,
          checkpoint: {
            id: "old",
            task: "parser",
            summary: "Stopped half way through the grammar.",
            done: ["Lexer"],
            next: ["Finish the grammar", "Docs"],
            decisions: [],
            files: [],
          },
        }),
      recall: () => ok({ results: [] }),
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.checkpoint?.task.nextAction).toBe("Finish the grammar");
    expect(resumed.text).toContain("Summary: Stopped half way through the grammar.");
    expect(resumed.text).toContain("Pending:\n- Docs");
  });

  it("finds checkpoints by task, for sessions that file them so", async () => {
    const vault = new FakeVault({ resume: () => saved(STATE), recall: () => ok({ results: [] }) });
    await compactResume({ vault, task: "parser" });
    expect(vault.called("resume")).toEqual([{ task: "parser" }]);
  });

  it("is far smaller than the room and checkpoint it replaces", async () => {
    // What the start brought before: the room (budget 1500) and the
    // checkpoint as Grafeno's pretty JSON.
    const room = "x".repeat(1500 * 4);
    const answer = saved(STATE);
    const before = estimateTokens(room) + estimateTokens(JSON.stringify(answer.data, null, 2));
    const vault = new FakeVault({ resume: () => answer, recall: () => ok({ results: [] }) });
    const after = (await compactResume({ vault, about: "p" })).stats.totalTokens;
    expect(after).toBeLessThan(before * 0.3);
  });
});

describe("compactResume relevance", () => {
  it("leaves out weak matches: far below the best one", async () => {
    const vault = new FakeVault({
      resume: () => saved(STATE),
      recall: () =>
        ok({
          results: [
            { ...memory("m1", "Strong match."), score: 2 },
            { ...memory("m2", "Fair match."), score: 1.2 },
            { ...memory("m3", "Weak match."), score: 0.4 },
          ],
        }),
    });
    const resumed = await compactResume({ vault, about: "p" });
    expect(resumed.memories.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(resumed.more).toEqual([]);
  });
});
