import { describe, expect, it } from "vitest";
import { packCheckpoint, readCheckpoint } from "../../src/memory/checkpoint.js";

describe("structured checkpoints in Grafeno's fields", () => {
  it("packs the state into Grafeno's fields and reads it back", () => {
    const packed = packCheckpoint({
      task: "parser",
      goal: "Parse the config language",
      status: "blocked",
      summary: "Lexer done; the parser waits on the grammar.",
      next_action: "Write the expression grammar",
      next: ["Error messages", "Docs"],
      done: ["Lexer"],
      blocked: ["Grammar: waits on the user's choice of precedence"],
      decisions: ["Hand-written parser, no generator"],
      files: ["src/parser.ts", "src/parser.ts"],
      errors: ["test/lexer.test.ts: 1 failing"],
      memory_refs: ["m1", "m1", "m2"],
      git_ref: "abc1234",
    });
    expect(packed).toMatchObject({
      task: "parser",
      next: ["Write the expression grammar", "Error messages", "Docs"],
      done: ["Lexer"],
      files: ["src/parser.ts"],
    });
    // Grafeno answers with what was saved, and an id and time of its own.
    const read = readCheckpoint({ ...packed, id: "c9", at: 1794718104985797, agent: "dev" });
    expect(read).toEqual({
      id: "c9",
      task: {
        id: "parser",
        goal: "Parse the config language",
        status: "blocked",
        nextAction: "Write the expression grammar",
      },
      summary: "Lexer done; the parser waits on the grammar.",
      progress: {
        completed: ["Lexer"],
        pending: ["Error messages", "Docs"],
        blocked: ["Grammar: waits on the user's choice of precedence"],
      },
      decisions: ["Hand-written parser, no generator"],
      files: ["src/parser.ts"],
      errors: ["test/lexer.test.ts: 1 failing"],
      memoryRefs: ["m1", "m2"],
      gitRef: "abc1234",
      updatedAt: new Date(1794718104985.797),
      agent: "dev",
    });
  });

  it("takes the first of next as the next action when none is named", () => {
    const packed = packCheckpoint({ task: "t", summary: "s", next: ["a", "b"] });
    expect(packed.next).toEqual(["a", "b"]);
    expect(readCheckpoint(packed)?.task.nextAction).toBe("a");
    expect(readCheckpoint(packed)?.progress.pending).toEqual(["b"]);
  });

  it("reads a checkpoint saved before this format (no state line)", () => {
    const read = readCheckpoint({
      task: "old",
      summary: "Half done.",
      done: ["x"],
      next: ["y"],
      decisions: ["d"],
      files: [],
    });
    expect(read).toMatchObject({
      task: { id: "old", status: "in_progress", nextAction: "y" },
      summary: "Half done.",
      errors: [],
      memoryRefs: [],
    });
  });

  it("does not stack state lines when a summary is saved again", () => {
    const once = packCheckpoint({ task: "t", summary: "s", status: "paused" });
    const twice = packCheckpoint({ task: "t", summary: String(once.summary), status: "done" });
    expect(String(twice.summary).match(/state:/g)).toHaveLength(1);
    expect(readCheckpoint(twice)?.task.status).toBe("done");
  });

  it("ignores a broken state line and an unknown status", () => {
    expect(readCheckpoint({ task: "t", summary: "s\nstate: {broken" })?.task.status).toBe(
      "in_progress",
    );
    expect(packCheckpoint({ task: "t", summary: "s", status: "whatever" }).summary).toContain(
      '"status":"in_progress"',
    );
  });
});
