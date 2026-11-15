import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexModel, codexCommand, codexError } from "../../src/model/codex.js";
import { FakeModel, ModelError, collectTurn, type Conversation } from "../../src/model/index.js";
import { describeModelContract } from "./contract.js";
import { RecordingToolHost } from "./tool-host.js";

// The adapter, run against a stand-in for `codex exec --json`: no plan usage.
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const fake = (options: { model?: string; effort?: string } = {}) =>
  new CodexModel({ command: process.execPath, commandPrefix: [FAKE_CODEX], ...options });

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
  });
}

async function withConversation(
  run: (conversation: Conversation, tools: RecordingToolHost) => Promise<void>,
  options: { system?: string; maxSteps?: number; model?: CodexModel } = {},
): Promise<void> {
  const tools = host();
  const conversation = await (options.model ?? fake({ model: "gpt-6-luna", effort: "low" })).open({
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

describe("CodexModel", { timeout: 30_000 }, () => {
  it("runs Codex as the brain only: read-only sandbox, its own tools off, only the agent's", async () => {
    await withConversation(async (conversation) => {
      const config = JSON.parse(
        (await collectTurn(conversation.send("config"))).result.text,
      ) as Record<string, unknown>;
      expect(config).toMatchObject({
        sandbox_mode: "read-only",
        approval_policy: "never",
        "features.shell_tool": false,
        "features.view_image": false,
        web_search: "disabled",
        "mcp_servers.agent.bearer_token_env_var": "GRAFENO_AGENT_MCP_TOKEN",
        // The agent's own permissions decide its tools' calls: Codex does not ask.
        "mcp_servers.agent.default_tools_approval_mode": "approve",
        model_reasoning_effort: "low",
      });
      // Told to use only the agent's tools, by name, before the agent's instructions.
      const instructions = String(config.developer_instructions);
      expect(instructions).toContain('the MCP server named "agent": echo');
      expect(instructions).toContain("do not use apply_patch");
      expect(instructions.endsWith("\n\nBe brief.")).toBe(true);
      expect(String(config["mcp_servers.agent.url"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const argv = JSON.parse(
        (await collectTurn(conversation.send("argv"))).result.text,
      ) as string[];
      expect(argv).toContain("--ignore-user-config");
      expect(argv).toContain("--json");
      expect(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2)).toEqual(["-m", "gpt-6-luna"]);
      // The MCP secret never goes on the command line.
      expect(argv.some((arg) => /Bearer|[0-9a-f]{64}/.test(arg))).toBe(false);
    });
  });

  it("passes the instructions with quotes and line breaks intact", async () => {
    const system = 'Line one.\nSay "hi" and use C:\\paths.';
    await withConversation(
      async (conversation) => {
        const config = JSON.parse((await collectTurn(conversation.send("config"))).result.text) as {
          developer_instructions: string;
        };
        expect(config.developer_instructions.endsWith(`\n\n${system}`)).toBe(true);
      },
      { system },
    );
  });

  it("answers, reports usage with the cache apart, and the context", async () => {
    await withConversation(async (conversation) => {
      const turn = await collectTurn(conversation.send("hello"));
      expect(turn.result).toMatchObject({
        text: "echo:hello",
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 3 },
      });
      expect(turn.events).toContainEqual({ type: "model_info", model: "gpt-6-luna" });
      expect(turn.events).toContainEqual({ type: "context", used: 120 });
    });
  });

  it("keeps the conversation: later turns resume the same thread", async () => {
    await withConversation(async (conversation) => {
      await collectTurn(conversation.send("remember:lima"));
      expect((await collectTurn(conversation.send("recall"))).result.text).toBe("word:lima");
    });
  });

  it("runs the agent's tools through its tool host, over MCP", async () => {
    await withConversation(async (conversation, tools) => {
      const turn = await collectTurn(conversation.send('call:echo:{"text":"hi"}'));
      expect(tools.calls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
      expect(turn.result.text).toBe("result:echoed hi");
      expect(turn.events.map((e) => e.type)).toEqual([
        "model_info",
        "tool_call",
        "tool_result",
        "text",
        "context",
        "done",
      ]);
    });
  });

  it("refuses tool calls past the step limit, and says it stopped there", async () => {
    await withConversation(
      async (conversation, tools) => {
        // No step left for a tool call: it is refused, and the turn says why it stopped.
        const turn = await collectTurn(conversation.send('call:echo:{"text":"a"}'));
        expect(tools.calls).toHaveLength(0);
        expect(turn.result.text).toContain("error:This turn has reached its step limit");
        expect(turn.result.stopReason).toBe("max_steps");
      },
      { maxSteps: 0 },
    );
  });

  it("reports the plan's usage limit, a missing sign-in and a lost conversation", async () => {
    await withConversation(async (conversation) => {
      expect((await failure(collectTurn(conversation.send("limit")))).kind).toBe("usage_limit");
      expect((await failure(collectTurn(conversation.send("logout")))).kind).toBe("setup");
      expect((await failure(collectTurn(conversation.send("lost")))).kind).toBe("lost");
      // The conversation goes on after a failed turn.
      expect((await collectTurn(conversation.send("again"))).result.text).toBe("echo:again");
    });
  });

  it("cancels a turn, and the conversation goes on (Codex keeps it)", async () => {
    await withConversation(async (conversation) => {
      await collectTurn(conversation.send("remember:sol"));
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 300);
      const error = await failure(
        collectTurn(conversation.send("slow", { signal: controller.signal })),
      );
      expect(error.kind).toBe("cancelled");
      expect((await collectTurn(conversation.send("recall"))).result.text).toBe("word:sol");
    });
  });

  it("says how to install Codex when it is missing", async () => {
    await withConversation(
      async (conversation) => {
        const error = await failure(collectTurn(conversation.send("hello")));
        expect(error.kind).toBe("setup");
        expect(error.message).toMatch(/npm install -g @openai\/codex/);
      },
      { model: new CodexModel({ command: "codex-not-installed-here", commandPrefix: [] }) },
    );
  });
});

describe("codexError", () => {
  it.each([
    ["You've hit your usage limit. Try again in 3 hours.", "usage_limit"],
    ["429 Too Many Requests: rate limit reached", "usage_limit"],
    ["Not logged in", "setup"],
    ["401 Unauthorized", "setup"],
    ["No session found with id 0198", "lost"],
    ["stream disconnected before completion", "unavailable"],
    ["something else went wrong", "failed"],
  ])("maps %s to %s", (text, kind) => {
    expect(codexError(text, 1).kind).toBe(kind);
  });
});

describe("codexCommand", () => {
  it("runs the npm package's launcher with Node on Windows, without a shell", () => {
    const found = codexCommand({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, (path) =>
      path.endsWith("codex.js"),
    );
    if (process.platform === "win32") {
      expect(found.command).toBe(process.execPath);
      expect(found.prefix[0]?.replace(/\\/g, "/")).toMatch(
        /npm\/node_modules\/@openai\/codex\/bin\/codex\.js$/,
      );
    } else {
      expect(found).toEqual({ command: "codex", prefix: [] });
    }
  });
});

// The same contract every model meets, on the stand-in (it echoes, so the
// fake model's scripts stand for what a real Codex does: see the live test).
describeModelContract("fake (for codex's shape)", (c) => new FakeModel({ turns: c.fake }));
