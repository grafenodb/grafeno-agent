import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { describeCall } from "../../src/app/session.js";
import { previousConversation, SessionStore } from "../../src/sessions/store.js";
import { updateSettings } from "../../src/settings-file.js";
import { parseCommand, suggest } from "../../src/tui/commands.js";
import { edit, EMPTY, insert } from "../../src/tui/editor.js";
import { blocks, spans } from "../../src/tui/markdown.js";

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const key = (k: Partial<Key>): Key => ({ ...none, ...k });

describe("the editor", () => {
  it("types, moves and erases", () => {
    let state = insert(EMPTY, "helo");
    state = edit(state, "", key({ leftArrow: true })) ?? state;
    state = edit(state, "l", none) ?? state;
    expect(state).toEqual({ value: "hello", cursor: 4 });
    state = edit(state, "", key({ backspace: true })) ?? state;
    state = edit(state, "", key({ delete: true })) ?? state;
    expect(state.value).toBe("heo");
    expect(edit(insert(EMPTY, "one two"), "w", key({ ctrl: true }))?.value).toBe("one ");
    expect(edit(state, "", key({ return: true }))).toBeUndefined();
  });
});

describe("the commands", () => {
  it("reads a command and its aliases, and suggests by prefix", () => {
    expect(parseCommand("/models")).toEqual({ name: "models", known: true, args: "" });
    expect(parseCommand("/model")).toEqual({ name: "models", known: true, args: "" });
    expect(parseCommand("/orchestrate build the API")).toEqual({
      name: "orchestrate",
      known: true,
      args: "build the API",
    });
    expect(parseCommand("/nope")).toEqual({ name: "nope", known: false, args: "" });
    expect(parseCommand("hello /models")).toBeUndefined();
    expect(suggest("/re").map((c) => c.name)).toEqual(["resume"]);
    expect(suggest("/").length).toBeGreaterThan(8);
    expect(suggest("/models now")).toEqual([]);
  });

  it("a command typed whole comes first, before longer ones that start the same", () => {
    // Enter takes the first suggestion: "/mode" must be /mode, not /models (alias "model").
    expect(suggest("/mode")[0]?.name).toBe("mode");
    expect(suggest("/mode").map((c) => c.name)).toContain("models");
    expect(suggest("/model")[0]?.name).toBe("models");
    expect(parseCommand("/mode auto")).toEqual({ name: "mode", known: true, args: "auto" });
  });
});

describe("markdown", () => {
  it("reads headings, lists, code and inline styles", () => {
    const read = blocks("# Title\n- one\n  - two\n```ts\nconst x = 1;\n```\n> quoted\n\n\ntext");
    expect(read.map((b) => b.kind)).toEqual([
      "heading",
      "item",
      "item",
      "code",
      "quote",
      "blank",
      "text",
    ]);
    expect(spans("a **b** `c` *d*")).toEqual([
      { text: "a " },
      { text: "b", style: "bold" },
      { text: " " },
      { text: "c", style: "code" },
      { text: " " },
      { text: "d", style: "italic" },
    ]);
  });
});

describe("kept conversations", () => {
  it("keeps, lists and loads them per project, without the agent's secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-store-"));
    try {
      const store = new SessionStore(dir, ["gk_secret_value_123"]);
      const first = store.create("demo");
      store.add(first, { kind: "user", text: "my key is gk_secret_value_123, keep it" });
      store.add(first, { kind: "assistant", text: "I will not store keys." });
      const second = store.create("demo");
      store.add(second, { kind: "user", text: "later" });
      expect(
        store
          .list("demo")
          .map((s) => s.title)
          .sort(),
      ).toEqual(["later", "my key is [secret], keep it"]);
      expect(store.list("other")).toEqual([]);
      const loaded = store.load("demo", first.id);
      expect(loaded?.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(loaded)).not.toContain("gk_secret_value_123");
      expect(store.load("demo", "../escape")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the model the earlier conversation as data, the latest first within a budget", () => {
    const at = new Date().toISOString();
    const text = previousConversation(
      [
        { kind: "user", text: "old message ".repeat(50), at },
        { kind: "tool", text: "read_file a.ts\ncontents", at },
        { kind: "assistant", text: "the latest answer", at },
      ],
      200,
    );
    expect(text).toContain("<previous_conversation>");
    expect(text).toContain("the latest answer");
    expect(text).toContain("Tool: read_file a.ts");
    expect(text).toContain("(earlier messages left out)");
    expect(previousConversation([])).toBe("");
  });
});

describe("updateSettings", () => {
  it("sets values and keeps the rest of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-settings-"));
    const path = join(dir, "config.env");
    try {
      writeFileSync(path, "# comment\nGRAFENO_URL=http://old\nAGENT_MODEL=claude-code\n");
      updateSettings({ GRAFENO_URL: "http://new:7810", GRAFENO_AGENT_KEY: "k" }, path);
      expect(readFileSync(path, "utf8")).toBe(
        "# comment\nGRAFENO_URL=http://new:7810\nAGENT_MODEL=claude-code\nGRAFENO_AGENT_KEY=k\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeCall", () => {
  it("names a call by its main argument", () => {
    expect(describeCall({ name: "read_file", input: { path: "src/a.ts" } })).toBe(
      "read_file src/a.ts",
    );
    expect(describeCall({ name: "current_time", input: {} })).toBe("current_time");
  });
});

describe("markdown tables", () => {
  it("reads a table into its header and rows, and shares the width by what each column holds", async () => {
    const { blocks, cells, columnWidths } = await import("../../src/tui/markdown.js");
    const read = blocks(
      "Intro\n\n| File | Purpose |\n|---|:---:|\n| app.tsx | The interface |\n| a\\|b | pipes |\n\nafter",
    );
    const table = read.find((b) => b.kind === "table");
    expect(table).toEqual({
      kind: "table",
      header: ["File", "Purpose"],
      rows: [
        ["app.tsx", "The interface"],
        ["a|b", "pipes"],
      ],
    });
    expect(cells("| x | y |")).toEqual(["x", "y"]);
    // Short columns as wide as what they hold; the last takes the rest.
    expect(columnWidths(["Language", "Year"], [["TypeScript", "2012, and a long note"]])).toEqual([
      12,
      undefined,
    ]);
    // A line of pipes that is not a table stays text.
    expect(blocks("| not a table |").map((b) => b.kind)).toEqual(["text"]);
  });
});

describe("what memory recalled", () => {
  it("reads Grafeno's context: each memory by name, and how many facts", async () => {
    const { readRecall } = await import("../../src/memory/session.js");
    const text = [
      "## Memory",
      "[1] Phase 9 agent identity decisions (Decision; stated)",
      "Grafeno Agent phase 9: an agent's name is its key's name…",
      "",
      "[2] (Checkpoint)",
      "Checkpoint of Grafeno Agent roadmap: phases 0 to 8 are done",
      "",
      "## Facts",
      "- “Phase 9…” depends_on “Phase 8…”",
      "- “Phase 9…” part_of Grafeno Agent project",
    ].join("\n");
    expect(readRecall(text)).toEqual({
      memories: [
        "Phase 9 agent identity decisions",
        "Checkpoint of Grafeno Agent roadmap: phases 0 to 8 are done",
      ],
      facts: 2,
    });
    expect(readRecall("")).toEqual({ memories: [], facts: 0 });
  });
});

describe("the mouse wheel", () => {
  it("reads wheel notches from the terminal's mouse reports, and nothing else", async () => {
    const { wheelTurns } = await import("../../src/tui/mouse.js");
    const ESC = String.fromCharCode(27);
    expect(wheelTurns(`${ESC}[<64;10;5M${ESC}[<64;10;5M${ESC}[<65;10;5M`)).toEqual([1, 1, -1]);
    // A click is not the wheel; typed text has no reports.
    expect(wheelTurns(`${ESC}[<0;10;5M${ESC}[<0;10;5m`)).toEqual([]);
    expect(wheelTurns("hello")).toEqual([]);
  });
});

describe("a permission request, in a line", () => {
  it("names the command or path its first line only announces", async () => {
    const { approvalSummary } = await import("../../src/tui/app.js");
    expect(approvalSummary("run in the project:\n      python -I -c 'print(1)'")).toBe(
      "run in the project: python -I -c 'print(1)'",
    );
    expect(approvalSummary("write a note")).toBe("write a note");
    expect(approvalSummary(`run in the project:\n${"x".repeat(300)}`)).toHaveLength(160);
  });
});

describe("clicks", () => {
  it("reads left presses from the terminal's mouse reports, and nothing else", async () => {
    const { clicksIn } = await import("../../src/tui/clicks.js");
    const ESC = String.fromCharCode(27);
    // A press at column 10, row 5 (1-based) is the cell (9, 4).
    expect(clicksIn(`${ESC}[<0;10;5M${ESC}[<0;10;5m`)).toEqual([{ x: 9, y: 4 }]);
    // The wheel, a drag, the right button and typed text are not clicks.
    expect(clicksIn(`${ESC}[<64;10;5M${ESC}[<32;10;5M${ESC}[<2;10;5Mhello`)).toEqual([]);
  });
});
