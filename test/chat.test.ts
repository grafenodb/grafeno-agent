import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { currentTimeTool } from "../src/agent/builtin-tools.js";
import { ToolRegistry, type Tool } from "../src/agent/tools.js";
import { runChat } from "../src/chat.js";
import { FakeModel, type FakeTurn } from "../src/model/index.js";

const note: Tool = {
  name: "write_note",
  description: "Writes a note.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  writes: true,
  run: (input) => `wrote ${String(input.text)}`,
};

/** Runs the chat on the fake model with these lines typed, and returns what it printed. */
async function chat(turns: FakeTurn[], typed: string[]): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });
  const model = new FakeModel({ turns });
  const done = runChat({
    input,
    output,
    makeAgent: (approve) =>
      new Agent({
        model,
        system: "test",
        tools: new ToolRegistry(
          [currentTimeTool(() => new Date("2026-11-14T12:00:00Z")), note],
          approve,
        ),
      }),
  });
  input.end(typed.map((line) => `${line}\n`).join(""));
  await done;
  return printed;
}

describe("runChat", () => {
  it("talks, shows the tools it uses, and leaves on /exit", async () => {
    const printed = await chat(
      [[{ say: "Hello!" }], [{ call: "current_time" }, { say: "It is noon." }]],
      ["hi", "what time is it?", "/exit", "never sent"],
    );
    expect(printed).toContain("Hello!");
    expect(printed).toContain("→ current_time {}");
    expect(printed).toContain("← 2026-11-14T12:00:00.000Z");
    expect(printed).toContain("It is noon.");
    expect(printed).not.toContain("never sent");
  });

  it("asks before a writing tool, and respects a no", async () => {
    const printed = await chat(
      [[{ call: "write_note", input: { text: "x" } }, { say: (c) => c.results[0]?.content ?? "" }]],
      ["note it", "n"],
    );
    expect(printed).toContain('write_note wants to run with {"text":"x"}');
    expect(printed).toContain("Allow it? [y/N]");
    expect(printed).toContain("did not allow");
  });

  it("runs a writing tool on a yes", async () => {
    const printed = await chat(
      [[{ call: "write_note", input: { text: "x" } }, { say: (c) => c.results[0]?.content ?? "" }]],
      ["note it", "y"],
    );
    expect(printed).toContain("wrote x");
  });

  it("shows the session's usage, and keeps going after an error", async () => {
    const printed = await chat(
      [[{ fail: "unavailable", message: "Overloaded", attempts: 1 }, { say: "back" }]],
      ["one", "two", "/usage"],
    );
    expect(printed).toContain("The model failed (unavailable): Overloaded");
    expect(printed).toContain("back");
    expect(printed).toMatch(/This session: 1 turns/);
  });

  it("says when the plan's usage limit stops it", async () => {
    const printed = await chat([[{ fail: "usage_limit", message: "limit reached" }]], ["hi"]);
    expect(printed).toContain("Stopped: limit reached");
  });
});
