import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionActions } from "../../src/app/connections.js";
import { collectTurn, ModelError, type ToolHost } from "../../src/model/index.js";
import { OllamaModel } from "../../src/model/ollama.js";
import { ChatCompletionsModel } from "../../src/model/openai-chat.js";
import {
  KNOWN_PROVIDERS,
  isLocalProvider,
  registerLocalConnections,
} from "../../src/providers/index.js";
import { discover } from "../../src/providers/local/discover.js";
import { checkEndpoint, resolveEndpoint } from "../../src/providers/local/endpoint.js";
import { LocalProvider } from "../../src/providers/local/provider.js";
import {
  builtInConnections,
  freeConnectionId,
  loadLocalConnections,
  removeLocalConnection,
  saveLocalConnection,
  type LocalConnection,
} from "../../src/providers/local/store.js";
import type { SecretStore } from "../../src/providers/secrets.js";
import {
  costRank,
  localCanTake,
  routeAcross,
  type ProviderEntry,
} from "../../src/orchestrator/router.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake server: answers by method and path, and keeps what it was asked. */
function server(routes: Record<string, (body: unknown, init?: RequestInit) => Response>) {
  const seen: { method: string; url: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const fetcher = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, body, headers: { ...(init?.headers as Record<string, string>) } });
    const path = new URL(url).pathname;
    const route = routes[`${method} ${path}`];
    if (!route) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(route(body, init));
  }) as typeof fetch;
  return { fetcher, seen };
}

function memoryStore(): SecretStore & { values: Record<string, string> } {
  const values: Record<string, string> = {};
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

/** A stream of chunks, as a server sends them. */
function streamed(chunks: readonly string[], contentType: string, delayMs = 0): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const tools: ToolHost = {
  tools: [
    {
      name: "read_file",
      description: "Reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      writes: false,
    },
  ],
  call: (call) => Promise.resolve({ content: `contents of ${String(call.input.path)}` }),
};

const OLLAMA_ROUTES = {
  "GET /api/version": () => json({ version: "0.12.3" }),
  "GET /api/tags": () =>
    json({
      models: [
        {
          name: "qwen3:8b",
          model: "qwen3:8b",
          size: 5_000_000_000,
          details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" },
        },
        { name: "gemma3:4b", model: "gemma3:4b" },
        { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" },
      ],
    }),
  "GET /api/ps": () => json({ models: [{ name: "qwen3:8b", model: "qwen3:8b" }] }),
  "POST /api/show": (body: unknown) => {
    const model = (body as { model: string }).model;
    if (model === "qwen3:8b") {
      return json({
        capabilities: ["completion", "tools", "thinking"],
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
      });
    }
    if (model === "gemma3:4b") {
      return json({
        capabilities: ["completion", "vision"],
        model_info: { "gemma3.context_length": 131072 },
      });
    }
    return json({ capabilities: ["embedding"], model_info: {} });
  },
};

describe("a model server's address", () => {
  it("says where it is: this computer, the network, or outside", () => {
    expect(checkEndpoint("http://localhost:11434/")).toMatchObject({
      ok: true,
      url: "http://localhost:11434",
      locality: "local",
    });
    expect(checkEndpoint("http://127.0.0.1:1234/v1")).toMatchObject({ locality: "local" });
    expect(checkEndpoint("http://[::1]:11434")).toMatchObject({ locality: "local" });
    expect(checkEndpoint("http://192.168.1.20:11434")).toMatchObject({ locality: "network" });
    expect(checkEndpoint("http://gpu-box:11434")).toMatchObject({ locality: "network" });
    expect(checkEndpoint("https://ai.example.com/v1")).toMatchObject({ locality: "remote" });
  });

  it("never reaches link-local, metadata or listening addresses, nor takes credentials in it", () => {
    for (const bad of [
      "http://169.254.169.254/latest",
      "http://[fe80::1]:80",
      "http://0.0.0.0:11434",
      "http://metadata.google.internal/",
      "http://user:pass@localhost:11434",
      "http://localhost:11434/?x=1",
      "ftp://localhost/",
      "not a url",
    ]) {
      expect(checkEndpoint(bad).ok, bad).toBe(false);
    }
  });

  it("never sends a key in the clear to another machine", () => {
    expect(checkEndpoint("http://localhost:1234/v1", { withKey: true }).ok).toBe(true);
    expect(checkEndpoint("http://192.168.1.5/v1", { withKey: true }).ok).toBe(false);
    expect(checkEndpoint("https://bionic.example.com/v1", { withKey: true }).ok).toBe(true);
  });

  it("judges a name by where it really leads", async () => {
    const checked = checkEndpoint("https://ai.example.com/v1");
    if (!checked.ok) throw new Error("expected ok");
    expect(
      await resolveEndpoint(checked, () => Promise.resolve(["169.254.169.254"])),
    ).toMatchObject({
      ok: false,
    });
    expect(await resolveEndpoint(checked, () => Promise.resolve(["10.0.0.7"]))).toMatchObject({
      ok: true,
      locality: "network",
    });
    expect(
      await resolveEndpoint(checked, () => Promise.resolve(["10.0.0.7", "93.184.215.14"])),
    ).toMatchObject({ locality: "remote" });
  });
});

describe("the list of local connections", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-local-"));
    file = join(dir, "local-connections.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("knows Ollama and LM Studio at their documented addresses, and keeps several more", () => {
    expect(loadLocalConnections(file).map((c) => `${c.id} ${c.url}`)).toEqual([
      "ollama http://localhost:11434",
      "lmstudio http://localhost:1234/v1",
    ]);
    saveLocalConnection(
      {
        id: "gpu-box",
        kind: "ollama",
        name: "Ollama (gpu-box)",
        url: "http://192.168.1.20:11434/",
      },
      file,
    );
    saveLocalConnection(
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        url: "http://127.0.0.1:11435",
        defaultModel: "qwen3:8b",
      },
      file,
    );
    const all = loadLocalConnections(file);
    expect(all.map((c) => c.id)).toEqual(["ollama", "lmstudio", "gpu-box"]);
    expect(all[0]).toMatchObject({ url: "http://127.0.0.1:11435", defaultModel: "qwen3:8b" });
    expect(all[2]?.url).toBe("http://192.168.1.20:11434");
    expect(() =>
      saveLocalConnection(
        { id: "x", kind: "bionic", name: "B", url: "http://169.254.169.254" },
        file,
      ),
    ).toThrow(/link-local/);
    expect(() =>
      saveLocalConnection(
        { id: "Bad Id", kind: "bionic", name: "B", url: "https://b.example" },
        file,
      ),
    ).toThrow(/lowercase/);
    expect(removeLocalConnection("gpu-box", file)).toBe(true);
    expect(removeLocalConnection("ollama", file)).toBe(true);
    expect(loadLocalConnections(file)).toEqual(builtInConnections());
    expect(freeConnectionId("ollama", ["ollama", "ollama-2"])).toBe("ollama-3");
    expect(freeConnectionId("openai-compatible", [])).toBe("custom");
  });
});

describe("discovering a server's models", () => {
  const ollama: LocalConnection = {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    url: "http://localhost:11434",
  };

  it("Ollama: its version, its chat models with tools, vision, context; embeddings left out", async () => {
    const { fetcher } = server(OLLAMA_ROUTES);
    const found = await discover(ollama, { fetch: fetcher });
    expect(found.reachable).toBe(true);
    expect(found.version).toBe("0.12.3");
    expect(found.models).toEqual([
      expect.objectContaining({
        id: "qwen3:8b",
        tools: true,
        thinking: true,
        contextLength: 40960,
        loaded: true,
        detail: "8.2B Q4_K_M",
      }),
      expect.objectContaining({
        id: "gemma3:4b",
        tools: false,
        vision: true,
        contextLength: 131072,
        loaded: false,
      }),
    ]);
  });

  it("LM Studio: its REST API's capabilities and loaded context, else older APIs", async () => {
    const lm: LocalConnection = {
      id: "lmstudio",
      kind: "lmstudio",
      name: "LM Studio",
      url: "http://localhost:1234/v1",
    };
    const v1 = server({
      "GET /api/v1/models": () =>
        json({
          models: [
            {
              type: "llm",
              key: "qwen/qwen3-coder-30b",
              display_name: "Qwen3 Coder 30B",
              max_context_length: 262144,
              loaded_instances: [{ id: "a", config: { context_length: 32768 } }],
              capabilities: { vision: false, trained_for_tool_use: true },
            },
            { type: "embedding", key: "nomic-embed" },
          ],
        }),
    });
    const found = await discover(lm, { fetch: v1.fetcher });
    expect(found.models).toEqual([
      expect.objectContaining({
        id: "qwen/qwen3-coder-30b",
        name: "Qwen3 Coder 30B",
        tools: true,
        loaded: true,
        contextLength: 32768,
      }),
    ]);
    const old = server({
      "GET /api/v0/models": () =>
        json({ data: [{ id: "llava", type: "vlm", state: "loaded", max_context_length: 4096 }] }),
    });
    const fromV0 = await discover(lm, { fetch: old.fetcher });
    expect(fromV0.models).toEqual([
      expect.objectContaining({ id: "llava", vision: true, loaded: true }),
    ]);
    expect(fromV0.models[0]?.tools).toBeUndefined();
  });

  it("Bionic and other OpenAI-compatible servers: their model list, with the key", async () => {
    const bionic: LocalConnection = {
      id: "bionic",
      kind: "bionic",
      name: "Bionic",
      url: "https://bionic.example.com/v1",
      hasKey: true,
    };
    const { fetcher, seen } = server({
      "GET /v1/models": () => json({ data: [{ id: "llama-3.3-70b" }] }),
    });
    const found = await discover(bionic, { fetch: fetcher, key: "bk-123" });
    expect(found.models).toEqual([{ id: "llama-3.3-70b", name: "llama-3.3-70b" }]);
    expect(seen[0]?.headers.authorization).toBe("Bearer bk-123");
    const refused = server({ "GET /v1/models": () => json({ error: "no" }, 401) });
    expect(await discover(bionic, { fetch: refused.fetcher })).toMatchObject({
      reachable: true,
      needsKey: true,
    });
    expect(await discover(bionic, { fetch: server({}).fetcher })).toMatchObject({
      reachable: false,
      error: "nothing answers at that address",
    });
  });
});

describe("Ollama's chat", () => {
  it("streams the answer, calls the agent's tools, and runs with the context it is given", async () => {
    let round = 0;
    const { fetcher, seen } = server({
      "POST /api/chat": () => {
        round++;
        return round === 1
          ? streamed(
              [
                `${JSON.stringify({ model: "qwen3:8b", message: { role: "assistant", content: "Let me look. " } })}\n`,
                `${JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] } })}\n`,
                `${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 9 })}\n`,
              ],
              "application/x-ndjson",
            )
          : streamed(
              [
                `${JSON.stringify({ message: { content: "It " } })}\n${JSON.stringify({ message: { content: "exports one function." } })}\n`,
                `${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 200, eval_count: 6 })}\n`,
              ],
              "application/x-ndjson",
            );
      },
    });
    const model = new OllamaModel({
      name: "Ollama",
      url: "http://localhost:11434",
      model: "qwen3:8b",
      options: { num_ctx: 32768, temperature: 0.2 },
      keepAlive: "10m",
      fetch: fetcher,
    });
    const conversation = await model.open({ system: "s", tools });
    const turn = await collectTurn(conversation.send("what is in a.ts?"));
    expect(turn.result.text).toBe("Let me look. It exports one function.");
    expect(turn.result.usage).toMatchObject({ inputTokens: 320, outputTokens: 15 });
    const first = seen[0]?.body as Record<string, unknown>;
    expect(first).toMatchObject({
      model: "qwen3:8b",
      stream: true,
      options: { num_ctx: 32768, temperature: 0.2 },
      keep_alive: "10m",
    });
    expect((first.tools as unknown[]).length).toBe(1);
    const second = seen[1]?.body as { messages: Record<string, unknown>[] };
    expect(second.messages.at(-1)).toEqual({
      role: "tool",
      tool_name: "read_file",
      content: "contents of a.ts",
    });
  });

  it("offers no tools to a model that takes none; says which model is missing; stops when cancelled", async () => {
    const { fetcher, seen } = server({
      "POST /api/chat": () =>
        streamed(
          [`${JSON.stringify({ message: { content: "hi" }, done: true })}\n`],
          "application/x-ndjson",
        ),
    });
    const plain = new OllamaModel({
      name: "Ollama",
      url: "http://localhost:11434",
      model: "gemma3:4b",
      noTools: true,
      fetch: fetcher,
    });
    await collectTurn((await plain.open({ system: "s", tools })).send("hello"));
    expect((seen[0]?.body as Record<string, unknown>).tools).toBeUndefined();

    const missing = new OllamaModel({
      name: "Ollama",
      url: "http://localhost:11434",
      model: "nope",
      fetch: server({ "POST /api/chat": () => json({ error: "model 'nope' not found" }, 404) })
        .fetcher,
    });
    await expect(
      collectTurn((await missing.open({ system: "s", tools })).send("hi")),
    ).rejects.toThrow(/ollama pull nope/);

    const slow = new OllamaModel({
      name: "Ollama",
      url: "http://localhost:11434",
      model: "qwen3:8b",
      fetch: server({
        "POST /api/chat": () =>
          streamed(
            Array.from({ length: 50 }, () => `${JSON.stringify({ message: { content: "x" } })}\n`),
            "application/x-ndjson",
            20,
          ),
      }).fetcher,
    });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 80);
    const error = await collectTurn(
      (await slow.open({ system: "s", tools })).send("go", { signal: controller.signal }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
  });
});

describe("the OpenAI-compatible adapter, streamed", () => {
  it("shows text as it comes, puts tool calls together, and sends no key when there is none", async () => {
    let round = 0;
    const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const { fetcher, seen } = server({
      "POST /v1/chat/completions": () => {
        round++;
        return round === 1
          ? streamed(
              [
                sse({
                  model: "qwen/qwen3-coder-30b",
                  choices: [{ delta: { content: "Reading" } }],
                }),
                sse({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          { index: 0, id: "c1", function: { name: "read_", arguments: '{"pa' } },
                        ],
                      },
                    },
                  ],
                }),
                sse({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          { index: 0, function: { name: "file", arguments: 'th":"b.ts"}' } },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }),
                "data: [DONE]\n\n",
              ],
              "text/event-stream",
            )
          : streamed(
              [
                sse({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }),
                sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 3 } }),
                "data: [DONE]\n\n",
              ],
              "text/event-stream",
            );
      },
    });
    const model = new ChatCompletionsModel({
      name: "LM Studio",
      api: "http://localhost:1234/v1",
      model: "qwen/qwen3-coder-30b",
      key: () => Promise.resolve(undefined),
      keyOptional: true,
      noKey: "no key",
      stream: true,
      inference: { temperature: 0.1 },
      fetch: fetcher,
    });
    const events: string[] = [];
    const conversation = await model.open({ system: "s", tools });
    for await (const event of conversation.send("look at b.ts")) {
      if (event.type === "text") events.push(`text:${event.text}`);
      if (event.type === "tool_call")
        events.push(`call:${event.call.name}:${JSON.stringify(event.call.input)}`);
    }
    expect(events).toEqual(["text:Reading", 'call:read_file:{"path":"b.ts"}', "text:Done."]);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.body).toMatchObject({ stream: true, temperature: 0.1 });
  });
});

describe("a local connection as a provider", () => {
  it("says whether its server answers, lists its models with what each can do, and picks a capable default", async () => {
    const { fetcher, seen } = server({
      ...OLLAMA_ROUTES,
      "POST /api/chat": () =>
        streamed(
          [`${JSON.stringify({ message: { content: "ok" }, done: true })}\n`],
          "application/x-ndjson",
        ),
    });
    const provider = new LocalProvider(
      { id: "ollama", kind: "ollama", name: "Ollama", url: "http://localhost:11434" },
      { fetch: fetcher, store: memoryStore() },
    );
    const status = await provider.status();
    expect(status).toMatchObject({
      installed: true,
      signedIn: true,
      version: "0.12.3",
      plan: "Local",
      billing: { kind: "local" },
    });
    expect(status.detail).toContain("2 models, 1 take tools");
    const models = await provider.models();
    expect(models.map((m) => m.id)).toEqual(["default", "qwen3:8b", "gemma3:4b"]);
    expect(models[1]?.hint).toContain("tools · 40k context · loaded");
    await collectTurn((await provider.create({}).open({ system: "s", tools })).send("hi"));
    const chat = seen.find((s) => s.url.endsWith("/api/chat"))?.body as Record<string, unknown>;
    expect(chat).toMatchObject({ model: "qwen3:8b", options: { num_ctx: 32768 } });
    // A model that takes no tools is offered none.
    await collectTurn(
      (await provider.create({ model: "gemma3:4b" }).open({ system: "s", tools })).send("hi"),
    );
    const plain = seen.filter((s) => s.url.endsWith("/api/chat")).at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(plain.model).toBe("gemma3:4b");
    expect(plain.tools).toBeUndefined();
  });

  it("is not used, and says so, when nothing answers", async () => {
    const provider = new LocalProvider(
      { id: "lmstudio", kind: "lmstudio", name: "LM Studio", url: "http://localhost:1234/v1" },
      { fetch: server({}).fetcher },
    );
    const status = await provider.status();
    expect(status).toMatchObject({ installed: false, signedIn: false });
    expect(status.detail).toContain("lms server start");
  });
});

const task = (complexity: number, kind: TaskSpec["kind"] = "docs"): TaskSpec =>
  ({
    id: "t",
    title: "t",
    kind,
    complexity,
    description: "",
    dependsOn: [],
    files: [],
    checks: [],
  }) as unknown as TaskSpec;
const catalog = {
  models: [{ id: "default", name: "Default" }],
  efforts: [],
  tiers: { deep: ["default"], standard: ["default"], light: ["default"] },
};

describe("routing with local models", () => {
  const sub: ProviderEntry = { id: "claude-code", catalog, billing: "subscription" };
  const paid: ProviderEntry = { id: "openai", catalog, billing: "metered" };
  const capable: ProviderEntry = {
    id: "ollama",
    catalog,
    billing: "local",
    local: { tools: true, contextLength: 32768, latencyMs: 40 },
  };
  const noTools: ProviderEntry = {
    id: "lmstudio",
    catalog,
    billing: "local",
    local: { tools: false },
  };
  const unknown: ProviderEntry = { id: "bionic", catalog, billing: "local", local: {} };

  it("a local model takes tool work only when it is known to take tools, with enough context", () => {
    expect(localCanTake(capable)).toBe(true);
    expect(localCanTake(noTools)).toBe(false);
    expect(localCanTake(unknown)).toBe(false);
    expect(localCanTake({ ...capable, local: { tools: true, contextLength: 4096 } })).toBe(false);
  });

  it("simple tasks go to a capable local model first; hard ones to subscriptions first; billed per token last", () => {
    const easy = routeAcross(task(1, "docs"), [paid, sub, noTools, capable]);
    expect(easy.kind === "run" && easy.provider).toBe("ollama");
    const hard = routeAcross(task(5, "backend"), [paid, capable, sub]);
    expect(hard.kind === "run" && hard.provider).toBe("claude-code");
    // Nothing but a paid API and a local model: the local one, never the bill first.
    const noSub = routeAcross(task(5, "backend"), [paid, capable]);
    expect(noSub.kind === "run" && noSub.provider).toBe("ollama");
    // Only local models that cannot work with tools: the task waits rather than fail.
    expect(routeAcross(task(1), [noTools, unknown]).kind).toBe("hold");
  });

  it("follows AGENT_LOCAL_ROUTING, and a slow server never comes first", () => {
    expect(costRank(capable, task(5, "backend"), { localRouting: "first" })).toBe(0);
    expect(costRank(capable, task(1), { localRouting: "last" })).toBe(2);
    expect(costRank({ ...capable, local: { ...capable.local, latencyMs: 45_000 } }, task(1))).toBe(
      2,
    );
    expect(costRank(paid, task(1))).toBe(3);
  });
});

describe("/connect's actions on local servers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-local-actions-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    registerLocalConnections(builtInConnections());
  });

  it("checks a server, keeps it with its key in the secure store, makes it a provider at once, and removes it", async () => {
    const file = join(dir, "local-connections.json");
    const store = memoryStore();
    const providers = [] as ReturnType<NonNullable<(typeof KNOWN_PROVIDERS)[string]>>[];
    const { fetcher } = server({
      "GET /v1/models": () => json({ data: [{ id: "llama-3.3-70b" }] }),
    });
    const actions = connectionActions({
      env: {},
      save: () => undefined,
      store,
      fetch: fetcher,
      providers,
      localFile: file,
      resolve: () => Promise.resolve(["203.0.113.10"]),
    });
    expect(await actions.checkServer("bionic", "http://169.254.169.254/v1")).toMatchObject({
      ok: false,
    });
    const clear = await actions.checkServer("bionic", "http://bionic.example.com/v1", "bk-1");
    expect(clear.ok).toBe(false);
    expect(clear.ok ? "" : clear.message).toContain("in the clear");
    const checked = await actions.checkServer("bionic", "https://bionic.example.com/v1", "bk-1");
    expect(checked).toMatchObject({ ok: true, locality: "remote" });
    const saved = await actions.saveServer({
      kind: "bionic",
      url: "https://bionic.example.com/v1",
      key: "bk-1",
      defaultModel: "llama-3.3-70b",
    });
    expect(saved.id).toBe("bionic");
    expect(store.values["bionic-key"]).toBe("bk-1");
    expect(loadLocalConnections(file).find((c) => c.id === "bionic")).toMatchObject({
      hasKey: true,
      defaultModel: "llama-3.3-70b",
    });
    expect(JSON.stringify(loadLocalConnections(file))).not.toContain("bk-1");
    expect(isLocalProvider("bionic")).toBe(true);
    expect("bionic" in KNOWN_PROVIDERS).toBe(true);
    expect(providers.map((p) => p.id)).toContain("bionic");
    // A second one of the same kind gets its own id.
    const second = await actions.saveServer({
      kind: "bionic",
      url: "https://other.example.com/v1",
      key: "bk-2",
    });
    expect(second.id).toBe("bionic-2");
    // The same server added again is the connection it was.
    const again = await actions.saveServer({
      kind: "bionic",
      url: "https://other.example.com/v1/",
    });
    expect(again.id).toBe("bionic-2");
    expect(await actions.removeServer("bionic")).toContain("removed");
    expect(store.values["bionic-key"]).toBeUndefined();
    expect("bionic" in KNOWN_PROVIDERS).toBe(false);
    expect(providers.map((p) => p.id)).not.toContain("bionic");
  });
});
