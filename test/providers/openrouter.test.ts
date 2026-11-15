import { describe, expect, it } from "vitest";
import { openRouterLogin, type LoginIo } from "../../src/app/login.js";
import { collectTurn, ModelError, type ToolHost } from "../../src/model/index.js";
import {
  FREE_ROUTER,
  OPENROUTER_ACCOUNT,
  OpenRouterAuth,
  OpenRouterCatalog,
  OpenRouterProvider,
  OpenRouterRuntime,
  openRouterLimits,
} from "../../src/providers/openrouter.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import type { SecretStore } from "../../src/providers/secrets.js";

const KEY = "sk-or-v1-test-not-real";

/** A fake OpenRouter: answers by path, and keeps every request. */
function openrouter(
  answer: (
    path: string,
    body: unknown,
  ) => { status?: number; json: unknown; headers?: Record<string, string> },
) {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
    const path = new URL(url).pathname.replace("/api/v1", "");
    const a = answer(path, body);
    return Promise.resolve(
      new Response(JSON.stringify(a.json), {
        status: a.status ?? 200,
        headers: { "content-type": "application/json", ...a.headers },
      }),
    );
  }) as typeof fetch;
  return { fetcher, requests };
}

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

const KEY_INFO = {
  data: {
    label: "laptop",
    limit: null,
    usage: 0,
    is_free_tier: true,
    free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
  },
};

const tools = (calls: string[] = []): ToolHost => ({
  tools: [
    {
      name: "read_file",
      description: "Reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      writes: false,
    },
  ],
  call: (call) => {
    calls.push(`${call.name}:${JSON.stringify(call.input)}`);
    return Promise.resolve({ content: "# Shop" });
  },
});

describe("the OpenRouter provider", () => {
  it("keeps authentication, model selection and execution apart", () => {
    const provider = new OpenRouterProvider({ env: {}, store: store() });
    expect(provider.parts.auth).toBeInstanceOf(OpenRouterAuth);
    expect(provider.parts.catalog).toBeInstanceOf(OpenRouterCatalog);
    expect(provider.parts.runtime).toBeInstanceOf(OpenRouterRuntime);
    expect(provider.parts.auth.method).toBe("api-key");
  });

  it("checks the key with OpenRouter; a refused one is not signed in, and never shown", async () => {
    const ok = openrouter(() => ({ json: KEY_INFO }));
    const status = await new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY },
      store: store(),
      fetch: ok.fetcher,
    }).status();
    expect(status).toMatchObject({ signedIn: true, billing: { kind: "free-api" } });
    expect(ok.requests[0]?.url).toBe("https://openrouter.ai/api/v1/key");
    expect(ok.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(status)).not.toContain(KEY);

    const refused = openrouter(() => ({
      status: 401,
      json: { error: { code: 401, message: "Invalid API key" } },
    }));
    const bad = await new OpenRouterProvider({
      env: {},
      store: store({ [OPENROUTER_ACCOUNT]: KEY }),
      fetch: refused.fetcher,
    }).status();
    expect(bad).toMatchObject({ signedIn: false });
    expect(bad.detail).toContain("refused the key");

    expect(await new OpenRouterProvider({ env: {}, store: store() }).status()).toMatchObject({
      signedIn: false,
    });
  });

  it("is free models only by default; paid models are metered and ready only when allowed", async () => {
    const { fetcher } = openrouter(() => ({ json: KEY_INFO }));
    const make = (models?: string) =>
      new OpenRouterProvider({
        env: { OPENROUTER_API_KEY: KEY, ...(models ? { OPENROUTER_MODELS: models } : {}) },
        store: store(),
        fetch: fetcher,
      });
    expect((await make().status()).billing?.kind).toBe("free-api");
    expect((await make("all").status()).billing?.kind).toBe("metered");
    expect(await new CapabilityRegistry({ providers: [make()], env: {} }).ready()).toHaveLength(1);
    expect(
      await new CapabilityRegistry({ providers: [make("all")], env: {} }).ready(),
    ).toHaveLength(0);
    expect(
      await new CapabilityRegistry({
        providers: [make("all")],
        env: { AGENT_ALLOW_BILLING: "openrouter" },
      }).ready(),
    ).toHaveLength(1);
  });

  it("reports the day's free requests and the credit limit, from the key", async () => {
    expect(openRouterLimits(KEY_INFO.data)).toEqual([{ label: "Free requests today", used: 0.24 }]);
    expect(openRouterLimits({ limit: 10, usage: 2.5 })).toEqual([
      { label: "Credit limit", used: 0.25 },
    ]);
    const { fetcher } = openrouter(() => ({ json: KEY_INFO }));
    const usage = await new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY },
      store: store(),
      fetch: fetcher,
    }).usage();
    expect(usage?.limits[0]?.label).toBe("Free requests today");
  });

  it("lists only free models that use tools, unless paid ones are allowed", async () => {
    const models = {
      data: [
        {
          id: "a/free-one:free",
          name: "Free One",
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["tools"],
        },
        {
          id: "a/paid",
          name: "Paid",
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools"],
        },
        {
          id: "a/notools:free",
          name: "No tools",
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["temperature"],
        },
      ],
    };
    const { fetcher, requests } = openrouter(() => ({ json: models }));
    const free = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY },
      store: store(),
      fetch: fetcher,
    });
    expect((await free.models()).map((m) => m.id)).toEqual(["default", "a/free-one:free"]);
    expect(requests[0]?.url).toContain("supported_parameters=tools");
    expect(free.tiers).toEqual({
      deep: [FREE_ROUTER],
      standard: [FREE_ROUTER],
      light: [FREE_ROUTER],
    });
    expect(free.efforts()).toEqual([]);
    const all = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODELS: "all" },
      store: store(),
      fetch: fetcher,
    });
    expect((await all.models()).map((m) => m.id)).toEqual(["default", "a/free-one:free", "a/paid"]);
  });

  it("refuses a paid model when only free ones are allowed, before any request", async () => {
    const { fetcher, requests } = openrouter(() => ({ json: {} }));
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY },
      store: store(),
      fetch: fetcher,
    });
    await expect(
      provider.create({ model: "openai/gpt-paid" }).open({ system: "", tools: tools() }),
    ).rejects.toMatchObject({
      kind: "setup",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("the OpenRouter model", () => {
  it("runs the agent's tools and sends their answers back, on the free router, never with a fallback list", async () => {
    let round = 0;
    const { fetcher, requests } = openrouter(() => {
      round++;
      return round === 1
        ? {
            json: {
              model: "a/free-one:free",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "read_file", arguments: '{"path":"README.md"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 5 },
            },
          }
        : {
            json: {
              choices: [{ finish_reason: "stop", message: { content: "It is a shop." } }],
              usage: {
                prompt_tokens: 80,
                completion_tokens: 6,
                prompt_tokens_details: { cached_tokens: 40 },
              },
            },
          };
    });
    const calls: string[] = [];
    const model = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: KEY },
      store: store(),
      fetch: fetcher,
    }).create({});
    const conversation = await model.open({ system: "Be brief.", tools: tools(calls) });
    const { result, events } = await collectTurn(conversation.send("What is it?"));
    expect(calls).toEqual(['read_file:{"path":"README.md"}']);
    expect(result).toMatchObject({ text: "It is a shop.", steps: 2, stopReason: "end_turn" });
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 11, cacheReadTokens: 40 });
    expect(events).toContainEqual({ type: "model_info", model: "a/free-one:free" });
    const first = requests[0];
    expect(first?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(first?.url).not.toContain(KEY);
    expect(first?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(first?.body).toMatchObject({
      model: FREE_ROUTER,
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(first?.body).not.toHaveProperty("models");
    const second = requests[1]?.body as { messages: unknown[] };
    expect(second.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "# Shop" },
    ]);
  });

  it("turns OpenRouter's errors into the agent's, never with the key, and keeps the conversation as it was", async () => {
    const cases: [number, Record<string, string>, string][] = [
      [429, { "retry-after": "20" }, "usage_limit"],
      [402, {}, "setup"],
      [401, {}, "setup"],
      [503, {}, "unavailable"],
      [400, {}, "failed"],
    ];
    for (const [status, headers, kind] of cases) {
      const { fetcher } = openrouter(() => ({
        status,
        headers,
        json: { error: { code: status, message: "no" } },
      }));
      const runtime = new OpenRouterRuntime(() => Promise.resolve(KEY), {
        fetch: fetcher,
        env: {},
        // Retried as for real, without the real waits (they made the test slow and flaky).
        resilience: { sleep: () => Promise.resolve() },
      });
      const model = runtime.create({});
      // The resilient wrapper retries what may pass; the kind is what matters here.
      const conversation = await model.open({ system: "", tools: tools() });
      const error = await collectTurn(conversation.send("Hi")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe(kind);
      expect((error as ModelError).message).not.toContain(KEY);
      if (status === 429)
        expect((error as ModelError).resetsAt?.getTime()).toBeGreaterThan(Date.now() - 1);
    }
    // An error inside a 200 is an error too.
    const { fetcher } = openrouter(() => ({
      json: { error: { code: 502, message: "model down" } },
    }));
    const model = new OpenRouterRuntime(() => Promise.resolve(KEY), {
      fetch: fetcher,
      env: {},
    }).create({});
    const conversation = await model.open({ system: "", tools: tools() });
    await expect(collectTurn(conversation.send("Hi"))).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("login openrouter", () => {
  function io(answers: string[]): LoginIo & { said: string[]; hidden: boolean[] } {
    const said: string[] = [];
    const hidden: boolean[] = [];
    return {
      said,
      hidden,
      ask: (_q, options) => {
        hidden.push(options?.hidden === true);
        return Promise.resolve(answers.shift() ?? "");
      },
      say: (line) => said.push(line),
    };
  }

  it("checks the key first, keeps it in the secure store, and adds it to Auto only if asked", async () => {
    const { fetcher, requests } = openrouter(() => ({ json: KEY_INFO }));
    const keys = store();
    const saved: Record<string, string>[] = [];
    const term = io([KEY, "", "y"]);
    const code = await openRouterLogin({
      io: term,
      store: keys,
      saveSettings: (v) => saved.push(v),
      autoMembers: ["claude-code", "codex"],
      fetch: fetcher,
    });
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/key");
    expect(keys.values[OPENROUTER_ACCOUNT]).toBe(KEY);
    expect(saved).toEqual([
      { OPENROUTER_MODELS: "free" },
      { AGENT_AUTO_PROVIDERS: "claude-code,codex,openrouter" },
    ]);
    expect(term.hidden[0]).toBe(true);
    const said = term.said.join("\n");
    expect(said).toContain("OpenRouter accepted the key (laptop)");
    expect(said).toContain("12 of 50");
    expect(said).not.toContain(KEY);
  });

  it("keeps nothing when OpenRouter refuses the key, and leaves Auto alone on no", async () => {
    const refused = openrouter(() => ({ status: 401, json: {} }));
    const keys = store();
    const saved: unknown[] = [];
    const term = io([KEY]);
    expect(
      await openRouterLogin({
        io: term,
        store: keys,
        saveSettings: (v) => saved.push(v),
        fetch: refused.fetcher,
      }),
    ).toBe(1);
    expect(term.said.join("\n")).toContain("refused the key");
    expect(keys.values).toEqual({});
    expect(saved).toEqual([]);

    const ok = openrouter(() => ({ json: KEY_INFO }));
    const paid = io([KEY, "all", "n"]);
    await openRouterLogin({
      io: paid,
      store: keys,
      saveSettings: (v) => saved.push(v),
      autoMembers: ["claude-code"],
      fetch: ok.fetcher,
    });
    expect(saved).toEqual([{ OPENROUTER_MODELS: "all" }]);
    expect(paid.said.join("\n")).toContain("AGENT_ALLOW_BILLING=openrouter");
  });
});
