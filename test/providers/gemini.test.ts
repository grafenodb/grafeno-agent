import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geminiLogin, type LoginIo } from "../../src/app/login.js";
import { collectTurn, ModelError, type ToolHost } from "../../src/model/index.js";
import { GeminiModel } from "../../src/model/gemini.js";
import {
  GEMINI_ACCOUNT,
  GeminiAuth,
  GeminiCatalog,
  GeminiProvider,
  GeminiRuntime,
  geminiModelName,
} from "../../src/providers/gemini.js";
import { PROVIDER_SECRET_ENV } from "../../src/providers/index.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import { DpapiStore, type SecretStore } from "../../src/providers/secrets.js";

const KEY = "AIza-test-key-not-real";

/** A fake Google: answers in order, and keeps every request it got. */
function google(answers: (url: string, body: unknown) => { status?: number; json: unknown }) {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
    const answer = answers(url, body);
    return Promise.resolve(
      new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetcher, requests };
}

function memoryStore(initial: Record<string, string> = {}): SecretStore & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    name: "test store",
    values,
    get: (account) => Promise.resolve(values[account]),
    set: (account, secret) => {
      values[account] = secret;
      return Promise.resolve();
    },
    delete: (account) => {
      Reflect.deleteProperty(values, account);
      return Promise.resolve();
    },
  };
}

const tools = (calls: string[] = []): ToolHost => ({
  tools: [
    {
      name: "read_file",
      description: "Reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      writes: false,
    },
  ],
  call: (call) => {
    calls.push(`${call.name}:${JSON.stringify(call.input)}`);
    return Promise.resolve({ content: "# Shop" });
  },
});

const text = (t: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
  modelVersion: "gemini-3-flash",
  ...extra,
});

describe("the Gemini model", () => {
  it("answers, with the key in a header (never the URL), the system and the tools declared", async () => {
    const { fetcher, requests } = google(() => ({ json: text("Hello.") }));
    const model = new GeminiModel({
      model: "gemini-flash-latest",
      effort: "low",
      key: () => Promise.resolve(KEY),
      fetch: fetcher,
    });
    const conversation = await model.open({ system: "Be brief.", tools: tools() });
    const { result, events } = await collectTurn(conversation.send("Hi"));
    expect(result).toMatchObject({ text: "Hello.", stopReason: "end_turn", steps: 1 });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 15 });
    expect(events).toContainEqual({ type: "model_info", model: "gemini-3-flash" });
    const sent = requests[0];
    expect(sent?.url).toMatch(/models\/gemini-flash-latest:generateContent$/);
    expect(sent?.url).not.toContain(KEY);
    expect(sent?.headers["x-goog-api-key"]).toBe(KEY);
    expect(sent?.body).toMatchObject({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "read_file", parametersJsonSchema: { required: ["path"] } },
          ],
        },
      ],
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("runs the agent's tools through its host, and sends Gemini's own parts back whole", async () => {
    let round = 0;
    const { fetcher, requests } = google(() => {
      round++;
      return round === 1
        ? {
            json: {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: { id: "fc1", name: "read_file", args: { path: "README.md" } },
                        thoughtSignature: "sig-1",
                      },
                    ],
                  },
                },
              ],
            },
          }
        : { json: text("It is a shop.") };
    });
    const calls: string[] = [];
    const model = new GeminiModel({ model: "m", key: () => Promise.resolve(KEY), fetch: fetcher });
    const conversation = await model.open({ system: "", tools: tools(calls) });
    const { result, events } = await collectTurn(conversation.send("What is it?"));
    expect(calls).toEqual(['read_file:{"path":"README.md"}']);
    expect(result).toMatchObject({ text: "It is a shop.", steps: 2 });
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    const second = requests[1]?.body as { contents: { role: string; parts: unknown[] }[] };
    expect(second.contents[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: { id: "fc1", name: "read_file", args: { path: "README.md" } },
          thoughtSignature: "sig-1",
        },
      ],
    });
    expect(second.contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "fc1", name: "read_file", response: { content: "# Shop" } } },
      ],
    });
  });

  it("turns Google's errors into the agent's, never with the key, and leaves the conversation as it was", async () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const cases: [number, unknown, string][] = [
      [429, { error: { message: "Quota", details: [{ retryDelay: "30s" }] } }, "usage_limit"],
      [403, { error: { message: "Permission denied" } }, "setup"],
      [503, { error: { message: "Overloaded" } }, "unavailable"],
      [400, { error: { message: "Bad" } }, "failed"],
    ];
    for (const [status, json, kind] of cases) {
      const { fetcher } = google(() => ({ status, json }));
      const model = new GeminiModel({
        model: "m",
        key: () => Promise.resolve(KEY),
        fetch: fetcher,
        now: () => now,
      });
      const conversation = await model.open({ system: "", tools: tools() });
      const error = await collectTurn(conversation.send("Hi")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe(kind);
      expect((error as ModelError).message).not.toContain(KEY);
      if (status === 429) {
        expect((error as ModelError).resetsAt?.toISOString()).toBe("2026-11-15T12:00:30.000Z");
      }
    }
    // The failed turn is not kept: the next one starts from the same history.
    let fail = true;
    const { fetcher, requests } = google(() =>
      fail ? { status: 503, json: {} } : { json: text("ok") },
    );
    const model = new GeminiModel({ model: "m", key: () => Promise.resolve(KEY), fetch: fetcher });
    const conversation = await model.open({ system: "", tools: tools() });
    await collectTurn(conversation.send("first")).catch(() => undefined);
    fail = false;
    await collectTurn(conversation.send("second"));
    expect((requests[1]?.body as { contents: unknown[] }).contents).toEqual([
      { role: "user", parts: [{ text: "second" }] },
    ]);
    // No key: set-up, before asking Google anything.
    const none = new GeminiModel({
      model: "m",
      key: () => Promise.resolve(undefined),
      fetch: fetcher,
    });
    const open = await none.open({ system: "", tools: tools() });
    await expect(collectTurn(open.send("Hi"))).rejects.toMatchObject({ kind: "setup" });
  });

  it("stops after the turn's step limit", async () => {
    const { fetcher } = google(() => ({
      json: {
        candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: {} } }] } }],
      },
    }));
    const model = new GeminiModel({ model: "m", key: () => Promise.resolve(KEY), fetch: fetcher });
    const conversation = await model.open({ system: "", tools: tools(), maxSteps: 3 });
    const { result } = await collectTurn(conversation.send("loop"));
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 3 });
  });
});

describe("the Gemini provider", () => {
  const models = {
    models: [
      {
        name: "models/gemini-3-flash",
        displayName: "Gemini 3 Flash",
        supportedGenerationMethods: ["generateContent"],
      },
      { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
    ],
  };

  it("keeps authentication, model selection and execution apart", () => {
    const provider = new GeminiProvider({ env: {}, store: memoryStore() });
    expect(provider.parts.auth).toBeInstanceOf(GeminiAuth);
    expect(provider.parts.catalog).toBeInstanceOf(GeminiCatalog);
    expect(provider.parts.runtime).toBeInstanceOf(GeminiRuntime);
    expect(provider.parts.auth.method).toBe("api-key");
    expect(provider.features).toMatchObject({ agentTools: true, nonInteractive: true });
  });

  it("is not signed in without a key, and finds one in the environment or the secure store", async () => {
    const { fetcher } = google(() => ({ json: models }));
    const none = new GeminiProvider({ env: {}, store: memoryStore(), fetch: fetcher });
    expect(await none.status()).toMatchObject({ installed: true, signedIn: false });
    const stored = new GeminiProvider({
      env: { GEMINI_TIER: "free" },
      store: memoryStore({ [GEMINI_ACCOUNT]: KEY }),
      fetch: fetcher,
    });
    const status = await stored.status();
    expect(status).toMatchObject({ signedIn: true, billing: { kind: "free-api" } });
    expect(status.detail).toContain("test store");
    expect(JSON.stringify(status)).not.toContain(KEY);
    const fromEnv = await new GeminiProvider({
      env: { GEMINI_API_KEY: KEY, GEMINI_TIER: "free" },
      store: memoryStore(),
      fetch: fetcher,
    }).status();
    expect(fromEnv.detail).toContain("GEMINI_API_KEY");
  });

  it("tells a free key from a billed or undeclared one, and only the free one is ready unasked", async () => {
    const { fetcher } = google(() => ({ json: models }));
    const make = (tier?: string) =>
      new GeminiProvider({
        env: { GEMINI_API_KEY: KEY, ...(tier ? { GEMINI_TIER: tier } : {}) },
        store: memoryStore(),
        fetch: fetcher,
      });
    expect((await make("paid").status()).billing?.kind).toBe("metered");
    expect((await make().status()).billing?.detail).toContain("GEMINI_TIER=free");
    for (const [tier, ready] of [
      ["free", true],
      ["paid", false],
      [undefined, false],
    ] as const) {
      const registry = new CapabilityRegistry({ providers: [make(tier)], env: {} });
      expect((await registry.ready()).length > 0).toBe(ready);
    }
    const allowed = new CapabilityRegistry({
      providers: [make("paid")],
      env: { AGENT_ALLOW_BILLING: "gemini" },
    });
    expect(await allowed.ready()).toHaveLength(1);
  });

  it("says when Google refuses the key", async () => {
    const { fetcher } = google(() => ({
      status: 400,
      json: { error: { message: "API key not valid" } },
    }));
    const status = await new GeminiProvider({
      env: { GEMINI_API_KEY: KEY },
      store: memoryStore(),
      fetch: fetcher,
    }).status();
    expect(status).toMatchObject({ signedIn: false });
    expect(status.detail).toContain("refused");
  });

  it("lists the models that generate content, with their names and thinking levels", async () => {
    const { fetcher } = google(() => ({ json: models }));
    const provider = new GeminiProvider({
      env: { GEMINI_API_KEY: KEY },
      store: memoryStore(),
      fetch: fetcher,
    });
    expect((await provider.models()).map((m) => m.id)).toEqual(["default", "gemini-3-flash"]);
    expect(provider.modelName("gemini-3-flash")).toBe("Gemini 3 Flash");
    expect(geminiModelName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(provider.efforts("gemini-3-flash")).toEqual(["low", "high"]);
    expect(provider.efforts("gemini-flash-latest")).toEqual(["low", "high"]);
    expect(provider.efforts("gemini-2.5-flash")).toEqual([]);
    expect(await provider.usage()).toBeUndefined();
  });

  it("hides the key variables from the commands the agent runs", () => {
    expect(PROVIDER_SECRET_ENV).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
      ]),
    );
  });
});

describe("login gemini", () => {
  function io(answers: string[]): LoginIo & { said: string[]; hidden: boolean[] } {
    const said: string[] = [];
    const hidden: boolean[] = [];
    return {
      said,
      hidden,
      ask: (_question, options) => {
        hidden.push(options?.hidden === true);
        return Promise.resolve(answers.shift() ?? "");
      },
      say: (line) => said.push(line),
    };
  }

  it("checks the key, keeps it in the secure store and the tier in the settings, never saying it", async () => {
    const { fetcher } = google(() => ({ json: { models: [] } }));
    const store = memoryStore();
    const saved: Record<string, string>[] = [];
    const term = io([KEY, "free"]);
    const code = await geminiLogin({
      io: term,
      store,
      saveSettings: (v) => saved.push(v),
      fetch: fetcher,
    });
    expect(code).toBe(0);
    expect(store.values[GEMINI_ACCOUNT]).toBe(KEY);
    expect(saved).toEqual([{ GEMINI_TIER: "free" }]);
    expect(term.hidden[0]).toBe(true);
    expect(term.said.join("\n")).not.toContain(KEY);
  });

  it("stores nothing when Google refuses the key or the tier is not given", async () => {
    const refused = google(() => ({ status: 400, json: {} }));
    const store = memoryStore();
    const saved: unknown[] = [];
    expect(
      await geminiLogin({
        io: io([KEY, "free"]),
        store,
        saveSettings: (v) => saved.push(v),
        fetch: refused.fetcher,
      }),
    ).toBe(1);
    const ok = google(() => ({ json: {} }));
    expect(
      await geminiLogin({
        io: io([KEY, "maybe"]),
        store,
        saveSettings: (v) => saved.push(v),
        fetch: ok.fetcher,
      }),
    ).toBe(1);
    expect(store.values).toEqual({});
    expect(saved).toEqual([]);
  });

  it("says a paid key is used only when allowed", async () => {
    const { fetcher } = google(() => ({ json: {} }));
    const term = io([KEY, "paid"]);
    await geminiLogin({
      io: term,
      store: memoryStore(),
      saveSettings: () => undefined,
      fetch: fetcher,
    });
    expect(term.said.join("\n")).toContain("AGENT_ALLOW_BILLING=gemini");
  });
});

describe.runIf(process.platform === "win32")(
  "the Windows secure store (DPAPI)",
  { timeout: 60_000 },
  () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ga-dpapi-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("seals a secret for this user only, and gives it back", async () => {
      const store = new DpapiStore(dir);
      const secret = "not-a-real-secret-123";
      await store.set("probe", secret);
      const sealed = readFileSync(join(dir, readdirSync(dir)[0] ?? ""), "utf8");
      expect(sealed).not.toContain(secret);
      expect(await store.get("probe")).toBe(secret);
      await store.delete("probe");
      expect(await store.get("probe")).toBeUndefined();
    });
  },
);
