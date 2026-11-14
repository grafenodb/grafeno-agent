import { describe, expect, it } from "vitest";
import { Agent, AgentError } from "../../src/agent/agent.js";
import { currentTimeTool } from "../../src/agent/builtin-tools.js";
import { ToolRegistry, type Approver, type Tool } from "../../src/agent/tools.js";
import {
  FakeModel,
  ModelError,
  type Conversation,
  type FakeTurn,
  type Model,
  type ModelEvent,
} from "../../src/model/index.js";

const NOW = new Date("2026-11-14T12:00:00Z");

function writeTool(written: string[]): Tool {
  return {
    name: "write_note",
    description: "Writes a note.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    writes: true,
    run: (input) => {
      written.push(String(input.text));
      return "written";
    },
  };
}

function agentWith(
  turns: FakeTurn[],
  options: {
    approve?: Approver;
    maxSteps?: number;
    maxSessionTokens?: number;
    tools?: Tool[];
  } = {},
) {
  const model = new FakeModel({ turns });
  const tools = new ToolRegistry(options.tools ?? [currentTimeTool(() => NOW)], options.approve);
  const agent = new Agent({
    model,
    system: "test",
    tools,
    limits: {
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.maxSessionTokens === undefined
        ? {}
        : { maxSessionTokens: options.maxSessionTokens }),
    },
  });
  return { agent, model };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("Agent", () => {
  it("holds a conversation and uses a trivial tool", async () => {
    const { agent, model } = agentWith([
      [{ say: "Hello." }],
      [{ call: "current_time" }, { say: (c) => `It is ${c.results[0]?.content ?? "?"}` }],
    ]);
    const events: ModelEvent[] = [];
    const first = await agent.turn("hi");
    const second = await agent.turn("what time is it?", { onEvent: (e) => events.push(e) });

    expect(first.result.text).toBe("Hello.");
    expect(second.result.text).toContain("2026-11-14T12:00:00.000Z");
    expect(second.result.steps).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(model.conversations).toHaveLength(1);
    expect(model.conversations[0]?.messages).toEqual(["hi", "what time is it?"]);
    expect(agent.turns).toBe(2);
  });

  it("stops a turn at its step limit", async () => {
    const { agent } = agentWith(
      [[{ call: "current_time" }, { say: "a" }, { call: "current_time" }, { say: "b" }]],
      { maxSteps: 2 },
    );
    const turn = await agent.turn("go");
    expect(turn.result.stopReason).toBe("max_steps");
  });

  it("refuses an empty message, and a second turn while one runs", async () => {
    const { agent } = agentWith([[{ wait: 50 }, { say: "ok" }]]);
    expect(await rejection(agent.turn("   "))).toMatchObject({ kind: "empty" });
    const running = agent.turn("one");
    expect(await rejection(agent.turn("two"))).toMatchObject({ kind: "busy" });
    await running;
  });

  it("counts what the session spends and stops at its token budget", async () => {
    const { agent } = agentWith([[{ say: "x".repeat(400) }]], { maxSessionTokens: 50 });
    await agent.turn("first");
    expect(agent.usage.outputTokens).toBe(100);
    const error = await rejection(agent.turn("second"));
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ kind: "budget" });
  });

  it("cancels a turn", async () => {
    const { agent } = agentWith([[{ wait: 5_000 }, { say: "late" }]]);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);
    const error = await rejection(agent.turn("slow", { signal: controller.signal }));
    expect(error).toMatchObject({ kind: "cancelled" });
  });

  it("passes the model's errors on", async () => {
    const { agent } = agentWith([[{ fail: "usage_limit" }]]);
    const error = await rejection(agent.turn("hi"));
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: "usage_limit" });
  });

  it("starts the conversation again when the model lost it, and says so", async () => {
    let opened = 0;
    const lostAfterFirst: Model = {
      name: "lossy",
      open: async (options) => {
        opened++;
        const inner: Conversation = await new FakeModel({ turns: [[{ say: "ok" }]] }).open(options);
        let sent = 0;
        return {
          close: () => inner.close(),
          send: (message, sendOptions) => {
            if (opened === 1 && sent++ >= 1) {
              throw new ModelError("lost", "Claude Code ended");
            }
            return inner.send(message, sendOptions);
          },
        };
      },
    };
    const agent = new Agent({ model: lostAfterFirst, system: "s", tools: new ToolRegistry() });
    expect((await agent.turn("one")).restarted).toBe(false);
    const second = await agent.turn("two");
    expect(second.restarted).toBe(true);
    expect(second.result.text).toBe("ok");
    expect(opened).toBe(2);
  });
});

describe("ToolRegistry", () => {
  const call = (name: string, input: Record<string, unknown> = {}) => ({ id: "1", name, input });
  const signal = new AbortController().signal;

  it("asks before a writing tool runs, and runs it when allowed", async () => {
    const written: string[] = [];
    const asked: string[] = [];
    const tools = new ToolRegistry([writeTool(written)], (c) => {
      asked.push(c.name);
      return true;
    });
    const outcome = await tools.call(call("write_note", { text: "hi" }), signal);
    expect(outcome).toEqual({ content: "written" });
    expect(asked).toEqual(["write_note"]);
    expect(written).toEqual(["hi"]);
  });

  it("does not run a writing tool the user refused, or when nobody can be asked", async () => {
    const written: string[] = [];
    const refused = new ToolRegistry([writeTool(written)], () => false);
    const unattended = new ToolRegistry([writeTool(written)]);
    for (const tools of [refused, unattended]) {
      const outcome = await tools.call(call("write_note", { text: "hi" }), signal);
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/did not allow/);
    }
    expect(written).toEqual([]);
  });

  it("never asks about a tool that only reads", async () => {
    let asked = false;
    const tools = new ToolRegistry([currentTimeTool(() => NOW)], () => {
      asked = true;
      return false;
    });
    const outcome = await tools.call(call("current_time"), signal);
    expect(outcome.isError).toBeUndefined();
    expect(asked).toBe(false);
  });

  it("checks arguments before asking or running", async () => {
    let asked = false;
    const tools = new ToolRegistry([writeTool([])], () => {
      asked = true;
      return true;
    });
    const outcome = await tools.call(call("write_note", { text: 3 }), signal);
    expect(outcome).toEqual({
      content: "Invalid arguments: input.text must be a string.",
      isError: true,
    });
    expect(asked).toBe(false);
  });

  it("turns a tool's failure and an unknown tool into errors for the model", async () => {
    const failing: Tool = {
      name: "boom",
      description: "",
      inputSchema: { type: "object" },
      writes: false,
      run: () => {
        throw new Error("no such file");
      },
    };
    const tools = new ToolRegistry([failing]);
    expect(await tools.call(call("boom"), signal)).toEqual({
      content: "boom failed: no such file",
      isError: true,
    });
    expect(await tools.call(call("nope"), signal)).toMatchObject({ isError: true });
  });

  it("refuses bad tool definitions", () => {
    expect(() => new ToolRegistry([{ ...writeTool([]), name: "bad name" }])).toThrow(/name/);
    expect(() => new ToolRegistry([writeTool([]), writeTool([])])).toThrow(/already/);
  });
});
