import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeModel,
  ModelError,
  collectTurn,
  type Conversation,
} from "../../src/model/index.js";
import { RecordingToolHost } from "./tool-host.js";

// The adapter, run against a stand-in for the `claude` program that speaks
// the same stream-json protocol: no plan usage is spent.
const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

const fakeSpawn = ((_command: string, args: readonly string[], options: object) =>
  spawn(process.execPath, [FAKE_CLAUDE, ...args], options)) as unknown as typeof spawn;

function host() {
  return new RecordingToolHost({
    echo: {
      spec: {
        description: "Says its text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        writes: false,
      },
      run: (input) => ({ content: `echoed ${String(input.text)}` }),
    },
    broken: {
      spec: { description: "Always fails.", inputSchema: { type: "object" }, writes: true },
      run: () => {
        throw new Error("disk full");
      },
    },
  });
}

async function withConversation(
  run: (conversation: Conversation, tools: RecordingToolHost) => Promise<void>,
  options: { system?: string; maxSteps?: number; command?: string } = {},
): Promise<void> {
  const tools = host();
  const model = new ClaudeCodeModel({
    model: "haiku",
    ...(options.command === undefined ? { spawn: fakeSpawn } : { command: options.command }),
  });
  const conversation = await model.open({
    system: options.system ?? "Be brief.",
    tools,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
  try {
    await run(conversation, tools);
  } finally {
    await conversation.close();
  }
}

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error("expected a ModelError");
}

describe("ClaudeCodeModel", () => {
  it("starts Claude Code as the brain only: no built-in tools, only the agent's", async () => {
    await withConversation(async (conversation) => {
      const turn = await collectTurn(conversation.send("args"));
      const args = JSON.parse(turn.result.text) as string[];
      expect(args).toContain("--tools=");
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--allowedTools=mcp__agent");
      expect(args).toContain("--permission-prompts=none");
      expect(args).toContain("--model=haiku");
      expect(args).not.toContain("--bare"); // it would ignore the subscription login
      expect(args.some((a) => a.includes("api-key") || a.includes("token"))).toBe(false);
    });
  });

  it("streams the answer and reports usage and the plan's windows", async () => {
    await withConversation(async (conversation) => {
      const turn = await collectTurn(conversation.send("hello"));
      expect(turn.result).toMatchObject({
        text: "echo:hello",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      });
      const windows = turn.events.find((e) => e.type === "usage_windows");
      expect(windows).toMatchObject({
        windows: [{ name: "five_hour", utilization: 0.25, allowed: true }],
      });
    });
  });

  it("passes the system prompt", async () => {
    await withConversation(
      async (conversation) => {
        const turn = await collectTurn(conversation.send("system"));
        expect(turn.result.text).toBe("You are the agent.");
      },
      { system: "You are the agent." },
    );
  });

  it("holds several turns in one conversation", async () => {
    await withConversation(async (conversation) => {
      expect((await collectTurn(conversation.send("one"))).result.text).toBe("echo:one");
      expect((await collectTurn(conversation.send("two"))).result.text).toBe("echo:two");
    });
  });

  it("runs the agent's tools through its tool host, over MCP", async () => {
    await withConversation(async (conversation, tools) => {
      const turn = await collectTurn(conversation.send('call:echo:{"text":"hi"}'));
      expect(tools.calls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
      expect(turn.result.text).toContain("result:echoed hi");
      expect(turn.result.text).toContain("tools:echo,broken");
      expect(turn.result.steps).toBe(2);
      expect(turn.events.map((e) => e.type)).toEqual([
        "usage_windows",
        "text",
        "tool_call",
        "tool_result",
        "text",
        "done",
      ]);
    });
  });

  it("gives the model a failing tool's error, not a crash", async () => {
    await withConversation(async (conversation) => {
      const turn = await collectTurn(conversation.send("call:broken:{}"));
      expect(turn.result.text).toContain("error:The tool failed: disk full");
    });
  });

  it("refuses tool calls past the step limit, and says it stopped there", async () => {
    await withConversation(
      async (conversation, tools) => {
        const turn = await collectTurn(conversation.send('call:echo:{"text":"x"}'));
        expect(tools.calls).toHaveLength(0);
        expect(turn.result.stopReason).toBe("max_steps");
      },
      { maxSteps: 1 },
    );
  });

  it("reports an overloaded API as retryable", async () => {
    await withConversation(async (conversation) => {
      const error = await failure(collectTurn(conversation.send("fail:529:Overloaded")));
      expect(error.kind).toBe("unavailable");
      expect(error.retryable).toBe(true);
      // The conversation goes on.
      expect((await collectTurn(conversation.send("again"))).result.text).toBe("echo:again");
    });
  });

  it("reports the plan's usage limit, with when it resets", async () => {
    await withConversation(async (conversation) => {
      const error = await failure(collectTurn(conversation.send("limit")));
      expect(error.kind).toBe("usage_limit");
      expect(error.retryable).toBe(false);
      expect(error.resetsAt?.getTime()).toBe(1794680400 * 1000);
    });
  });

  it("says to sign in when Claude Code is not signed in", async () => {
    await withConversation(async (conversation) => {
      const error = await failure(collectTurn(conversation.send("logout")));
      expect(error.kind).toBe("setup");
      expect(error.message).toMatch(/\/login/);
    });
  });

  it("says the conversation is lost when Claude Code ends", async () => {
    await withConversation(async (conversation) => {
      const error = await failure(collectTurn(conversation.send("exit")));
      expect(error.kind).toBe("lost");
      expect(() => conversation.send("more")).toThrow(ModelError);
    });
  });

  it("cancels a turn by stopping Claude Code", async () => {
    await withConversation(async (conversation) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 200);
      const error = await failure(
        collectTurn(conversation.send("slow", { signal: controller.signal })),
      );
      expect(error.kind).toBe("cancelled");
    });
  });

  it("says how to install Claude Code when it is missing", async () => {
    await withConversation(
      async (conversation) => {
        let error: unknown;
        try {
          await collectTurn(conversation.send("hello"));
        } catch (caught) {
          error = caught;
        }
        if (!(error instanceof ModelError)) {
          // The spawn error may arrive before the first send.
          expect(() => conversation.send("hello")).toThrow(/not found/);
          return;
        }
        expect(error.kind).toBe("setup");
        expect(error.message).toMatch(/not found/);
      },
      { command: "claude-does-not-exist-here" },
    );
  });
});
