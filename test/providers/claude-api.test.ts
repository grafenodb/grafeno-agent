/* eslint-disable @typescript-eslint/require-await -- the SDK stand-ins are async generators, as the SDK's own stream is. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { claudeApiLogin, type LoginIo } from "../../src/app/login.js";
import {
  agentEnv,
  ClaudeAgentModel,
  type AgentSdk,
  type SdkMessage,
} from "../../src/model/claude-agent.js";
import { collectTurn, ModelError, type ModelEvent } from "../../src/model/index.js";
import {
  CLAUDE_API_ACCOUNT,
  ClaudeApiProvider,
  type ClientSdk,
} from "../../src/providers/claude-api.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import type { SecretStore } from "../../src/providers/secrets.js";
import { RecordingToolHost } from "../model/tool-host.js";

const KEY = "sk-ant-api03-test-not-real";

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

const init = (extra: Record<string, unknown> = {}): SdkMessage => ({
  type: "system",
  subtype: "init",
  apiKeySource: "ANTHROPIC_API_KEY",
  model: "claude-sonnet-5-5",
  session_id: "session-1",
  ...extra,
});
const delta = (text: string): SdkMessage => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const success = (extra: Record<string, unknown> = {}): SdkMessage => ({
  type: "result",
  subtype: "success",
  session_id: "session-1",
  result: "Hello.",
  stop_reason: "end_turn",
  num_turns: 1,
  total_cost_usd: 0.0125,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 5,
  },
  ...extra,
});

/** A stand-in for the Agent SDK: records each query, and answers with a script. */
function fakeSdk(
  script: (options: Record<string, unknown>, turn: number) => AsyncIterable<SdkMessage>,
): AgentSdk & { calls: { prompt: string; options: Record<string, unknown> }[] } {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  return {
    calls,
    query(params) {
      calls.push(params);
      return script(params.options, calls.length);
    },
  };
}

function model(
  sdk: AgentSdk,
  extra: Partial<ConstructorParameters<typeof ClaudeAgentModel>[0]> = {},
) {
  return new ClaudeAgentModel({
    model: "sonnet",
    key: () => Promise.resolve(KEY),
    sdk: () => Promise.resolve(sdk),
    env: {
      PATH: "/bin",
      GRAFENO_AGENT_KEY: "gk_secret",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      GEMINI_API_KEY: "AIza-secret",
    },
    ...extra,
  });
}

describe("claude-api's model (the Agent SDK)", () => {
  it("streams the answer, with usage and cost, and runs the SDK safely configured", async () => {
    const sdk = fakeSdk(async function* () {
      yield init();
      yield delta("Hel");
      yield delta("lo.");
      yield success();
    });
    const conversation = await model(sdk).open({ system: "Be brief.", tools: host(), maxSteps: 7 });
    const { result, events } = await collectTurn(conversation.send("Hi"));
    expect(
      events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text),
    ).toEqual(["Hel", "lo."]);
    expect(events).toContainEqual({ type: "model_info", model: "claude-sonnet-5-5" });
    expect(result).toMatchObject({
      text: "Hello.",
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        costUsd: 0.0125,
      },
    });
    const options = sdk.calls[0]?.options ?? {};
    expect(sdk.calls[0]?.prompt).toBe("Hi");
    expect(options).toMatchObject({
      systemPrompt: "Be brief.",
      tools: [],
      settingSources: [],
      allowedTools: ["mcp__agent"],
      permissionMode: "default",
      includePartialMessages: true,
      model: "sonnet",
      maxTurns: 7,
    });
    expect((options.mcpServers as { agent: { type: string; url: string } }).agent.type).toBe(
      "http",
    );
    // Its own environment: the API key and a private configuration folder, nothing else secret.
    const env = options.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.PATH).toBe("/bin");
    expect(env).not.toHaveProperty("GRAFENO_AGENT_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
    // Any tool but the agent's own is refused.
    const canUseTool = options.canUseTool as () => Promise<{ behavior: string }>;
    expect((await canUseTool()).behavior).toBe("deny");
    expect(options.abortController).toBeInstanceOf(AbortController);
    await conversation.close();
  });

  it("goes on with the same session on the next turn", async () => {
    const sdk = fakeSdk(async function* () {
      yield init();
      yield success();
    });
    const conversation = await model(sdk).open({ system: "", tools: host() });
    await collectTurn(conversation.send("one"));
    await collectTurn(conversation.send("two"));
    expect(sdk.calls[0]?.options).not.toHaveProperty("resume");
    expect(sdk.calls[1]?.options.resume).toBe("session-1");
    await conversation.close();
  });

  it("runs the agent's tools through its own MCP server, each call decided by the agent", async () => {
    const tools = host();
    const sdk = fakeSdk(async function* (options) {
      yield init();
      // As the SDK would: a call to the agent's MCP server, over HTTP.
      const server = (
        options.mcpServers as { agent: { url: string; headers: Record<string, string> } }
      ).agent;
      const client = new Client({ name: "fake-sdk", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      const answer = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      await client.close();
      const text = (answer.content as { text: string }[])[0]?.text ?? "";
      yield delta(text);
      yield success({ result: text });
    });
    const conversation = await model(sdk).open({ system: "", tools });
    const { result, events } = await collectTurn(conversation.send("echo it"));
    expect(tools.calls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool_call", "tool_result", "text", "done"]),
    );
    expect(result.text).toBe("echoed hi");
    await conversation.close();
  });

  it("stops when the SDK did not sign in with the API key: never a subscription", async () => {
    for (const source of ["oauth", "/login managed key", "none"]) {
      const sdk = fakeSdk(async function* () {
        yield init({ apiKeySource: source });
        yield success();
      });
      const conversation = await model(sdk).open({ system: "", tools: host() });
      const error = await collectTurn(conversation.send("Hi")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe("setup");
      expect((error as ModelError).message).toMatch(/only with an API key/);
      await conversation.close();
    }
  });

  it("turns the SDK's errors into the agent's, with the key never in a message", async () => {
    const cases: [SdkMessage, string][] = [
      [{ type: "assistant", error: "rate_limit" }, "usage_limit"],
      [{ type: "assistant", error: "authentication_failed" }, "setup"],
      [{ type: "assistant", error: "billing_error" }, "setup"],
      [{ type: "assistant", error: "overloaded" }, "unavailable"],
      [{ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.5 }, "failed"],
      [
        {
          type: "result",
          subtype: "error_during_execution",
          errors: [`bad request with ${KEY}`],
        },
        "failed",
      ],
    ];
    for (const [message, kind] of cases) {
      const sdk = fakeSdk(async function* () {
        yield init();
        yield message;
      });
      // Without the resilient wrapper: the raw kind is what is checked.
      const conversation = await model(sdk).open({ system: "", tools: host() });
      const error = await collectTurn(conversation.send("Hi")).catch((e: unknown) => e);
      expect((error as ModelError).kind).toBe(kind);
      expect((error as ModelError).message).not.toContain(KEY);
      await conversation.close();
    }
    // The step limit is a stop, not an error.
    const capped = fakeSdk(async function* () {
      yield init();
      yield { type: "result", subtype: "error_max_turns", num_turns: 3 };
    });
    const conversation = await model(capped).open({ system: "", tools: host() });
    expect((await collectTurn(conversation.send("Hi"))).result.stopReason).toBe("max_steps");
    await conversation.close();
  });

  it("cancels: the SDK's own abort controller is aborted, and the turn says cancelled", async () => {
    let controller: AbortController | undefined;
    const sdk = fakeSdk(async function* (options) {
      controller = options.abortController as AbortController;
      yield init();
      yield delta("Thinking");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      yield success();
    });
    const conversation = await model(sdk).open({ system: "", tools: host() });
    const abort = new AbortController();
    const events: ModelEvent[] = [];
    const error = await (async () => {
      for await (const event of conversation.send("long", { signal: abort.signal })) {
        events.push(event);
        if (event.type === "text") abort.abort();
      }
    })().catch((e: unknown) => e);
    expect((error as ModelError).kind).toBe("cancelled");
    expect(controller?.signal.aborted).toBe(true);
    await conversation.close();
  });

  it("says what to do without a key or without the SDK", async () => {
    const sdk = fakeSdk(async function* () {
      yield success();
    });
    const noKey = await model(sdk, { key: () => Promise.resolve(undefined) }).open({
      system: "",
      tools: host(),
    });
    await expect(collectTurn(noKey.send("Hi"))).rejects.toMatchObject({ kind: "setup" });
    await noKey.close();
    const noSdk = await model(sdk, {
      sdk: () => Promise.reject(new Error("Cannot find package")),
    }).open({
      system: "",
      tools: host(),
    });
    await expect(collectTurn(noSdk.send("Hi"))).rejects.toThrow(/providers install claude-api/);
    await noSdk.close();
    expect(sdk.calls).toEqual([]);
    expect(agentEnv({ PATH: "/x", ANTHROPIC_API_KEY: "other" }, KEY, "/cfg")).toEqual({
      PATH: "/x",
      ANTHROPIC_API_KEY: KEY,
      CLAUDE_CONFIG_DIR: "/cfg",
    });
  });
});

function store(
  initial: Record<string, string> = {},
): SecretStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    name: "test store",
    values,
    get: (a) => Promise.resolve(values[a]),
    set: (a, s) => {
      values[a] = s;
      return Promise.resolve();
    },
    delete: (a) => {
      Reflect.deleteProperty(values, a);
      return Promise.resolve();
    },
  };
}

const client =
  (behaviour: "ok" | 401 | "down"): (() => Promise<ClientSdk>) =>
  () =>
    Promise.resolve({
      listModels: (key: string) =>
        behaviour === "ok"
          ? Promise.resolve([
              { id: "claude-sonnet-5-5", name: `Sonnet 5.5 (${key === KEY ? "right key" : "?"})` },
            ])
          : Promise.reject(
              Object.assign(new Error("no"), behaviour === 401 ? { status: 401 } : {}),
            ),
    });

const sdkPresent = () => Promise.resolve(fakeSdk(async function* () {}));

describe("the claude-api provider", () => {
  it("is not available without the SDK, or without a key, and says how", async () => {
    const missing = new ClaudeApiProvider({
      env: { ANTHROPIC_API_KEY: KEY },
      store: store(),
      agentSdk: () => Promise.reject(new Error("Cannot find package")),
      clientSdk: client("ok"),
    });
    expect(await missing.status()).toMatchObject({ installed: false, signedIn: false });
    expect((await missing.status()).detail).toContain("providers install claude-api");
    const noKey = new ClaudeApiProvider({
      env: {},
      store: store(),
      agentSdk: sdkPresent,
      clientSdk: client("ok"),
    });
    expect(await noKey.status()).toMatchObject({ installed: true, signedIn: false });
  });

  it("checks the key with the API, is always billed per token, and is ready only when allowed", async () => {
    const refused = new ClaudeApiProvider({
      env: {},
      store: store({ [CLAUDE_API_ACCOUNT]: KEY }),
      agentSdk: sdkPresent,
      clientSdk: client(401),
    });
    expect(await refused.status()).toMatchObject({ signedIn: false });
    const make = () =>
      new ClaudeApiProvider({
        env: { ANTHROPIC_API_KEY: KEY },
        store: store(),
        agentSdk: sdkPresent,
        clientSdk: client("ok"),
      });
    const status = await make().status();
    expect(status).toMatchObject({ signedIn: true, billing: { kind: "metered" } });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await new CapabilityRegistry({ providers: [make()], env: {} }).ready()).toEqual([]);
    expect(
      await new CapabilityRegistry({
        providers: [make()],
        env: { AGENT_ALLOW_BILLING: "claude-api" },
      }).ready(),
    ).toHaveLength(1);
    // Unreachable: signed in, said not checked.
    const down = new ClaudeApiProvider({
      env: { ANTHROPIC_API_KEY: KEY },
      store: store(),
      agentSdk: sdkPresent,
      clientSdk: client("down"),
    });
    expect((await down.status()).detail).toContain("not checked");
  });

  it("lists the API's models with the family aliases", async () => {
    const provider = new ClaudeApiProvider({
      env: { ANTHROPIC_API_KEY: KEY },
      store: store(),
      agentSdk: sdkPresent,
      clientSdk: client("ok"),
    });
    expect((await provider.models()).map((m) => m.id)).toEqual([
      "default",
      "haiku",
      "sonnet",
      "opus",
      "claude-sonnet-5-5",
    ]);
    expect(provider.tiers).toMatchObject({ light: ["haiku", "sonnet"] });
  });
});

describe("login claude-api", () => {
  function io(answers: string[]): LoginIo & { said: string[] } {
    const said: string[] = [];
    return { said, ask: () => Promise.resolve(answers.shift() ?? ""), say: (l) => said.push(l) };
  }

  it("keeps a key the API accepts, and allows billing only on an explicit yes", async () => {
    const keys = store();
    const saved: Record<string, string>[] = [];
    const no = io([KEY, ""]);
    expect(
      await claudeApiLogin({
        io: no,
        store: keys,
        saveSettings: (v) => saved.push(v),
        listModels: () => Promise.resolve([{ id: "m" }]),
        allowedBilling: [],
      }),
    ).toBe(0);
    expect(keys.values[CLAUDE_API_ACCOUNT]).toBe(KEY);
    expect(saved).toEqual([]);
    expect(no.said.join("\n")).toContain("stays unused");
    expect(no.said.join("\n")).not.toContain(KEY);
    const yes = io([KEY, "y"]);
    await claudeApiLogin({
      io: yes,
      store: keys,
      saveSettings: (v) => saved.push(v),
      listModels: () => Promise.resolve([{ id: "m" }]),
      allowedBilling: ["gemini"],
    });
    expect(saved).toEqual([{ AGENT_ALLOW_BILLING: "gemini,claude-api" }]);
  });

  it("keeps nothing when the API refuses the key", async () => {
    const keys = store();
    const term = io([KEY]);
    expect(
      await claudeApiLogin({
        io: term,
        store: keys,
        saveSettings: () => undefined,
        listModels: () => Promise.reject(Object.assign(new Error("no"), { status: 401 })),
        allowedBilling: [],
      }),
    ).toBe(1);
    expect(keys.values).toEqual({});
    expect(term.said.join("\n")).toContain("refused the key");
  });
});
