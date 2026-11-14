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
    expect(parseCommand("/models")).toEqual({ name: "models", known: true });
    expect(parseCommand("/model")).toEqual({ name: "models", known: true });
    expect(parseCommand("/nope")).toEqual({ name: "nope", known: false });
    expect(parseCommand("hello /models")).toBeUndefined();
    expect(suggest("/re").map((c) => c.name)).toEqual(["resume"]);
    expect(suggest("/").length).toBeGreaterThan(8);
    expect(suggest("/models now")).toEqual([]);
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
