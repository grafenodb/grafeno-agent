import { describe, expect, it } from "vitest";
import {
  connectionActions,
  connectionRecord,
  describeConnections,
  stateOf,
} from "../../src/app/connections.js";
import { keyLogin, type LoginIo } from "../../src/app/login.js";
import { collectTurn, type ToolHost } from "../../src/model/index.js";
import {
  API_KEY_SPECS,
  apiKeySpec,
  ApiKeyProvider,
  checkKey,
  endpointOf,
  keyAccount,
} from "../../src/providers/api-key.js";
import { KNOWN_PROVIDERS } from "../../src/providers/index.js";
import { PROVIDER_PROFILES, providerEnabled, withSwitch } from "../../src/providers/profiles.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import type { SecretStore } from "../../src/providers/secrets.js";
import type { Provider, ProviderStatus } from "../../src/providers/types.js";

const KEY = "sk-test-not-real-0123456789";

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

/** A fake vendor API: answers by path, and keeps every request. */
function vendor(answer: (path: string, body: unknown) => { status?: number; json: unknown }) {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
    const a = answer(new URL(url).pathname, body);
    return Promise.resolve(
      new Response(JSON.stringify(a.json), {
        status: a.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetcher, requests };
}

const MODELS = { data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] };
const tools: ToolHost = { tools: [], call: () => Promise.resolve({ content: "" }) };

describe("the connection registry", () => {
  it("knows each connection's vendor, type, sign-in, cost and standing", () => {
    for (const id of Object.keys(KNOWN_PROVIDERS)) {
      const profile = PROVIDER_PROFILES[id];
      expect(profile, id).toBeDefined();
      expect(["cli", "api-key", "coding-plan", "local"]).toContain(profile?.connectionType);
    }
    // One vendor, several connections.
    const byVendor = (vendorId: string) =>
      Object.values(PROVIDER_PROFILES)
        .filter((p) => p.vendor === vendorId)
        .map((p) => `${p.id}:${p.connectionType}`);
    expect(byVendor("anthropic")).toEqual(["claude-code:cli", "claude-api:api-key"]);
    expect(byVendor("moonshot")).toEqual([
      "kimi-code:cli",
      "moonshot:api-key",
      "kimi-plan:coding-plan",
    ]);
    expect(byVendor("openai")).toEqual(["codex:cli", "openai:api-key"]);
    expect(PROVIDER_PROFILES["claude-code"]?.compliance).toBe("pending-anthropic-review");
    expect(PROVIDER_PROFILES["zai-plan"]?.compliance).toBe("restricted-supported-tools");
  });

  it("starts coding plans of uncertain terms off; the user may switch them on, and anything off", () => {
    expect(providerEnabled("kimi-plan", {})).toBe(false);
    expect(providerEnabled("kimi-plan", { PROVIDER_KIMI_PLAN_ENABLED: "true" })).toBe(true);
    expect(providerEnabled("deepseek", {})).toBe(true);
    expect(providerEnabled("deepseek", { PROVIDER_DEEPSEEK_ENABLED: "false" })).toBe(false);
    expect(providerEnabled("claude-code", {})).toBe(true);
  });

  it("never calls a connection connected when its program is only installed", () => {
    const fake = (id: string): Provider => KNOWN_PROVIDERS[id]?.() as Provider;
    const status = (s: Partial<ProviderStatus>): ProviderStatus => ({
      installed: true,
      signedIn: false,
      detail: "d",
      ...s,
    });
    expect(stateOf(connectionRecord(fake("copilot"), status({}), {}))).toBe(
      "Installed, not signed in",
    );
    expect(stateOf(connectionRecord(fake("copilot"), status({ installed: false }), {}))).toBe(
      "Not installed",
    );
    expect(stateOf(connectionRecord(fake("deepseek"), status({}), {}))).toBe("Not configured");
    const metered = status({ signedIn: true, billing: { kind: "metered", detail: "" } });
    expect(stateOf(connectionRecord(fake("deepseek"), metered, {}))).toBe(
      "Connected, billing not allowed",
    );
    expect(
      stateOf(connectionRecord(fake("deepseek"), metered, { AGENT_ALLOW_BILLING: "deepseek" })),
    ).toBe("Connected");
    expect(stateOf(connectionRecord(fake("kimi-plan"), status({ signedIn: true }), {}))).toBe(
      "Switched off",
    );
    const record = connectionRecord(fake("copilot"), status({ signedIn: true }), {});
    expect(record).toMatchObject({
      providerId: "github",
      connectionId: "copilot",
      connectionType: "cli",
      authMethod: "github-account",
      authenticated: true,
      available: true,
      supportsMCP: true,
      supportsHeadless: true,
      costModel: "subscription",
      complianceStatus: "documented",
    });
    const table = describeConnections([record], true).join("\n");
    expect(table).toMatch(/GitHub\s+copilot\s+CLI\s+Connected/);
  });
});

describe("connections by key", () => {
  const deepseek = apiKeySpec("deepseek");
  if (!deepseek) throw new Error("no deepseek spec");

  it("checks a key by listing models (free); a refused key is never kept", async () => {
    const ok = vendor(() => ({ json: MODELS }));
    expect(await checkKey(deepseek, KEY, { env: {}, fetch: ok.fetcher })).toMatchObject({
      ok: true,
    });
    expect(ok.requests[0]?.url).toBe("https://api.deepseek.com/models");
    expect(ok.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const refused = vendor(() => ({ status: 401, json: {} }));
    expect(await checkKey(deepseek, KEY, { env: {}, fetch: refused.fetcher })).toMatchObject({
      ok: false,
      refused: true,
    });
    // An API with no free check says so, and never spends to find out.
    const minimax = apiKeySpec("minimax");
    if (!minimax) throw new Error("no minimax spec");
    const none = vendor(() => ({ json: {} }));
    expect(await checkKey(minimax, KEY, { env: {}, fetch: none.fetcher })).toMatchObject({
      ok: false,
      refused: false,
    });
    expect(none.requests).toEqual([]);
  });

  it("uses only a documented endpoint, chosen by its setting", () => {
    const moonshot = apiKeySpec("moonshot");
    if (!moonshot) throw new Error("no moonshot spec");
    expect(endpointOf(moonshot, {}).url).toBe("https://api.moonshot.ai/v1");
    expect(endpointOf(moonshot, { MOONSHOT_ENDPOINT: "china" }).url).toBe(
      "https://api.moonshot.cn/v1",
    );
    // An endpoint not documented is not taken.
    expect(endpointOf(moonshot, { MOONSHOT_ENDPOINT: "https://evil.example" }).url).toBe(
      "https://api.moonshot.ai/v1",
    );
  });

  it("is billed per token (an API) or spends a plan (a coding plan), and is ready only when allowed and on", async () => {
    const { fetcher } = vendor(() => ({ json: MODELS }));
    const make = (id: string) => {
      const spec = apiKeySpec(id);
      if (!spec) throw new Error(id);
      return withSwitch(
        new ApiKeyProvider(spec, {
          env: {},
          store: store({ [keyAccount(id)]: KEY }),
          fetch: fetcher,
        }),
        () => ({}),
      );
    };
    expect((await make("deepseek").status()).billing?.kind).toBe("metered");
    expect(
      await new CapabilityRegistry({ providers: [make("deepseek")], env: {} }).ready(),
    ).toEqual([]);
    expect(
      await new CapabilityRegistry({
        providers: [make("deepseek")],
        env: { AGENT_ALLOW_BILLING: "deepseek" },
      }).ready(),
    ).toHaveLength(1);
    // A coding plan starts off: not ready until switched on.
    expect((await make("kimi-plan").status()).signedIn).toBe(false);
  });

  it("runs on the vendor's first listed model when none is chosen, and reads the balance for free", async () => {
    const { fetcher, requests } = vendor((path) =>
      path.endsWith("/models")
        ? { json: MODELS }
        : path.endsWith("/user/balance")
          ? {
              json: {
                is_available: true,
                balance_infos: [{ currency: "USD", total_balance: "4.20" }],
              },
            }
          : {
              json: {
                choices: [{ finish_reason: "stop", message: { content: "Hello." } }],
                usage: { prompt_tokens: 3, completion_tokens: 2 },
              },
            },
    );
    const provider = new ApiKeyProvider(deepseek, {
      env: {},
      store: store({ [keyAccount("deepseek")]: KEY }),
      fetch: fetcher,
    });
    const conversation = await provider.create({}).open({ system: "", tools });
    expect((await collectTurn(conversation.send("Hi"))).result.text).toBe("Hello.");
    const chat = requests.find((r) => r.url.endsWith("/chat/completions"));
    expect(chat?.body).toMatchObject({ model: "deepseek-v4-pro" });
    expect((await provider.usage())?.limits[0]?.label).toBe("Balance 4.20 USD");
  });

  it("covers every vendor of the brief, each with a key variable and a documented endpoint", () => {
    expect(API_KEY_SPECS.map((s) => s.id)).toEqual([
      "openai",
      "deepseek",
      "mistral",
      "moonshot",
      "qwen",
      "zai",
      "minimax",
      "xai",
      "kimi-plan",
      "zai-plan",
      "minimax-plan",
      "qwen-plan",
    ]);
    for (const spec of API_KEY_SPECS) {
      expect(spec.keyVariables.length).toBeGreaterThan(0);
      expect(spec.endpoints[0]?.url).toMatch(/^https:\/\//);
    }
  });
});

describe("login <connection>", () => {
  function io(answers: string[]): LoginIo & { said: string[] } {
    const said: string[] = [];
    return { said, ask: () => Promise.resolve(answers.shift() ?? ""), say: (l) => said.push(l) };
  }
  const deepseek = apiKeySpec("deepseek");
  const plan = apiKeySpec("zai-plan");
  if (!deepseek || !plan) throw new Error("specs");

  it("keeps a checked key in the secure store, and allows billing only on an explicit yes", async () => {
    const { fetcher } = vendor(() => ({ json: MODELS }));
    const keys = store();
    const saved: Record<string, string>[] = [];
    const term = io([KEY, "", ""]);
    expect(
      await keyLogin(deepseek, {
        io: term,
        store: keys,
        saveSettings: (v) => saved.push(v),
        allowedBilling: [],
        enabled: true,
        env: {},
        fetch: fetcher,
      }),
    ).toBe(0);
    expect(keys.values[keyAccount("deepseek")]).toBe(KEY);
    expect(saved).toEqual([]);
    expect(term.said.join("\n")).not.toContain(KEY);
    await keyLogin(deepseek, {
      io: io([KEY, "y", ""]),
      store: keys,
      saveSettings: (v) => saved.push(v),
      allowedBilling: [],
      enabled: true,
      env: {},
      fetch: fetcher,
    });
    expect(saved).toEqual([{ AGENT_ALLOW_BILLING: "deepseek" }]);
  });

  it("refuses a key the vendor refuses, and asks before switching on a plan of restricted terms", async () => {
    const refused = vendor(() => ({ status: 401, json: {} }));
    const keys = store();
    expect(
      await keyLogin(deepseek, {
        io: io([KEY]),
        store: keys,
        saveSettings: () => undefined,
        allowedBilling: [],
        enabled: true,
        env: {},
        fetch: refused.fetcher,
      }),
    ).toBe(1);
    expect(keys.values).toEqual({});
    const ok = vendor(() => ({ json: { data: [{ id: "glm-5.3" }] } }));
    const saved: Record<string, string>[] = [];
    const term = io([KEY, "", ""]);
    await keyLogin(plan, {
      io: term,
      store: keys,
      saveSettings: (v) => saved.push(v),
      allowedBilling: [],
      enabled: false,
      env: {},
      fetch: ok.fetcher,
    });
    expect(term.said.join("\n")).toMatch(/limits it to the coding tools it lists/);
    expect(saved).toEqual([]);
    expect(term.said.join("\n")).toContain("stays off");
  });
});

describe("/connect's actions", () => {
  it("checks and keeps a key, disconnects it, switches and allows billing", async () => {
    const env: Record<string, string | undefined> = {};
    const saved: Record<string, string>[] = [];
    const keys = store();
    const { fetcher } = vendor(() => ({ json: MODELS }));
    const actions = connectionActions({
      env,
      save: (v) => {
        saved.push(v);
        Object.assign(env, v);
      },
      store: keys,
      fetch: fetcher,
    });
    expect(await actions.setKey("deepseek", ` ${KEY} `)).toMatchObject({ ok: true });
    expect(keys.values[keyAccount("deepseek")]).toBe(KEY);
    expect((await actions.setKey("copilot", KEY)).ok).toBe(false);
    expect(await actions.disconnect("deepseek")).toContain("disconnected");
    expect(keys.values).toEqual({});
    expect(await actions.disconnect("copilot")).toContain("sign out there");
    actions.setEnabled("claude-code", false);
    expect(saved.at(-1)).toEqual({
      PROVIDER_CLAUDE_CODE_LOCAL_ENABLED: "false",
      PROVIDER_CLAUDE_CODE_ENABLED: "false",
    });
    actions.setBilling("deepseek", true);
    actions.setBilling("openai", true);
    expect(env.AGENT_ALLOW_BILLING).toBe("deepseek,openai");
    actions.setBilling("deepseek", false);
    expect(env.AGENT_ALLOW_BILLING).toBe("openai");
  });
});
