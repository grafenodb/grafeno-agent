import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { assertBillingAllowed, billingRefusal } from "../../src/providers/billing.js";
import { CachedAuth, ProviderStateCache } from "../../src/providers/cache.js";
import {
  ClaudeCodeAuth,
  ClaudeCodeCatalog,
  ClaudeCodeProvider,
  ClaudeCodeRuntime,
  claudeBilling,
  type RunClaude,
} from "../../src/providers/claude-code.js";
import { withCache } from "../../src/providers/index.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import type {
  Provider,
  ProviderAuth,
  ProviderStatus,
  ProviderUsage,
} from "../../src/providers/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-billing-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `claude` signed in as `auth` says. */
function claude(auth: Record<string, unknown>): { run: RunClaude; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      if (args[0] === "--version") return Promise.resolve("2.1.325 (Claude Code)\n");
      if (args[0] === "auth") return Promise.resolve(JSON.stringify(auth));
      return Promise.resolve(
        JSON.stringify({ result: "Current session: 18% used · resets 3:39pm" }),
      );
    },
  };
}

describe("Claude Code's parts", () => {
  it("keeps authentication, model selection and execution apart", () => {
    const { run, calls } = claude({ loggedIn: true, authMethod: "claude.ai" });
    const provider = new ClaudeCodeProvider(run);
    expect(provider.parts.auth).toBeInstanceOf(ClaudeCodeAuth);
    expect(provider.parts.catalog).toBeInstanceOf(ClaudeCodeCatalog);
    expect(provider.parts.runtime).toBeInstanceOf(ClaudeCodeRuntime);
    // The facade is only the parts: tiers from the catalog, features from the runtime.
    expect(provider.tiers).toBe(provider.parts.catalog.tiers);
    expect(provider.features).toBe(provider.parts.runtime.features);
    expect(provider.signIn).toBe(provider.parts.auth.signIn);
    expect(provider.parts.auth.method).toBe("provider-cli");
    // Execution asks nothing of the sign-in: making a model runs no command.
    provider.create({ model: "haiku", effort: "low" });
    expect(calls).toEqual([]);
    // Another authentication part changes nothing else.
    const other: ProviderAuth = {
      method: "provider-cli",
      signIn: "elsewhere",
      status: () => Promise.resolve({ installed: true, signedIn: false, detail: "no" }),
      usage: () => Promise.resolve(undefined),
    };
    const swapped = provider.withAuth(other);
    expect(swapped.signIn).toBe("elsewhere");
    expect(swapped.parts.catalog).toBe(provider.parts.catalog);
    expect(swapped.parts.runtime).toBe(provider.parts.runtime);
  });

  it("tells a subscription from a sign-in that bills by consumption", async () => {
    expect(
      claudeBilling({ authMethod: "claude.ai", apiProvider: "firstParty" }, "Claude Pro"),
    ).toEqual({
      kind: "subscription",
      detail: "Your Claude Pro plan",
    });
    expect(claudeBilling({ authMethod: "api_key" }, undefined).kind).toBe("metered");
    expect(claudeBilling({ authMethod: "claude.ai", apiProvider: "bedrock" }, undefined)).toEqual({
      kind: "metered",
      detail: "Claude Code goes through bedrock",
    });

    const plan = await new ClaudeCodeProvider(
      claude({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }).run,
    ).status();
    expect(plan.billing).toEqual({ kind: "subscription", detail: "Your Claude Pro plan" });
    const key = await new ClaudeCodeProvider(
      claude({ loggedIn: true, authMethod: "api_key" }).run,
    ).status();
    expect(key).toMatchObject({ signedIn: true, billing: { kind: "metered" } });
    expect(key.detail).toContain("bills by consumption");
  });
});

describe("billing by consumption", () => {
  const metered: ProviderStatus = {
    installed: true,
    signedIn: true,
    detail: "",
    billing: { kind: "metered", detail: "An API key" },
  };

  it("is refused unless the user expressly allowed that provider", async () => {
    expect(billingRefusal("gemini", metered, {})).toContain("AGENT_ALLOW_BILLING=gemini");
    expect(billingRefusal("gemini", metered, { AGENT_ALLOW_BILLING: "codex" })).toBeDefined();
    expect(
      billingRefusal("gemini", metered, { AGENT_ALLOW_BILLING: "codex, gemini" }),
    ).toBeUndefined();
    for (const kind of ["subscription", "free-api"] as const) {
      expect(
        billingRefusal("gemini", { ...metered, billing: { kind, detail: "" } }, {}),
      ).toBeUndefined();
    }
    const provider = fake("claude-code", metered);
    await expect(assertBillingAllowed(provider, {})).rejects.toThrow(/bills by consumption/);
    await expect(
      assertBillingAllowed(provider, { AGENT_ALLOW_BILLING: "claude-code" }),
    ).resolves.toBeUndefined();
  });

  it("is never a fallback: the registry leaves it out of the ready providers", async () => {
    const registry = new CapabilityRegistry({
      providers: [fake("claude-code"), fake("gemini", metered)],
      env: {},
    });
    expect((await registry.ready()).map((c) => c.id)).toEqual(["claude-code"]);
    expect((await registry.capabilities("gemini")).billing?.kind).toBe("metered");
    const allowed = new CapabilityRegistry({
      providers: [fake("claude-code"), fake("gemini", metered)],
      env: { AGENT_ALLOW_BILLING: "gemini" },
    });
    expect((await allowed.ready()).map((c) => c.id)).toEqual(["claude-code", "gemini"]);
  });

  it("stops a run on one metered provider before anything is planned", async () => {
    let created = 0;
    const provider = {
      ...fake("claude-code", metered),
      create: () => (created++, new FakeModel({ turns: [] })),
    };
    const orchestrator = new Orchestrator({
      provider,
      project: { name: "shop", path: dir },
      projectRoot: dir,
      dataDir: join(dir, "data"),
      metrics: false,
    });
    try {
      await expect(orchestrator.plan("Write it")).rejects.toThrow(/bills by consumption/);
      expect(created).toBe(0);
    } finally {
      orchestrator.close();
    }
  });
});

describe("the provider cache", () => {
  /** An authentication part that counts how often it is asked. */
  function counting() {
    const asked = { status: 0, usage: 0 };
    let usage: ProviderUsage | undefined = {
      limits: [{ label: "Session", used: 0.18 }],
      at: new Date("2026-11-15T10:00:00Z"),
    };
    const auth: ProviderAuth = {
      method: "provider-cli",
      signIn: "sign in",
      status: async () => {
        asked.status++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { installed: true, signedIn: true, detail: "ok" };
      },
      usage: () => {
        asked.usage++;
        return Promise.resolve(usage);
      },
    };
    return {
      asked,
      auth,
      fail: () => {
        usage = undefined;
      },
    };
  }

  it("reuses an answer for a minute, asks again after it, and on request", async () => {
    let now = 1_000_000;
    const cache = new ProviderStateCache(undefined, () => now);
    const { asked, auth } = counting();
    const cached = new CachedAuth("claude-code", auth, cache);
    // Asked at once: one question.
    await Promise.all([cached.status(), cached.status(), cached.status()]);
    expect(asked.status).toBe(1);
    const first = await cached.usage();
    now += 59_000;
    const again = await cached.usage();
    expect(asked.usage).toBe(1);
    // It says when the provider was asked, not when the cache was read.
    expect(again?.at).toEqual(first?.at);
    expect(again?.at).toBeInstanceOf(Date);
    await cached.usage({ fresh: true });
    expect(asked.usage).toBe(2);
    now += 61_000;
    await cached.usage();
    await cached.status();
    expect(asked).toEqual({ status: 2, usage: 3 });
  });

  it("does not keep a failed answer", async () => {
    const cache = new ProviderStateCache();
    const { asked, auth, fail } = counting();
    fail();
    const cached = new CachedAuth("codex", auth, cache);
    expect(await cached.usage()).toBeUndefined();
    expect(await cached.usage()).toBeUndefined();
    expect(asked.usage).toBe(2);
  });

  it("is shared with the agent's other processes through its file, with no credential in it", async () => {
    const file = join(dir, "provider-state.json");
    const one = counting();
    const two = counting();
    await new CachedAuth("claude-code", one.auth, new ProviderStateCache(file)).usage();
    // Another process: its own cache object, the same file.
    const other = await new CachedAuth(
      "claude-code",
      two.auth,
      new ProviderStateCache(file),
    ).usage();
    expect(two.asked.usage).toBe(0);
    expect(other?.limits[0]?.used).toBe(0.18);
  });

  it("wraps the known providers' authentication, and nothing else", () => {
    const provider = new ClaudeCodeProvider(claude({}).run);
    const wrapped = withCache(provider);
    expect("parts" in wrapped && wrapped.parts.auth).toBeInstanceOf(CachedAuth);
    expect("parts" in wrapped && wrapped.parts.catalog).toBe(provider.parts.catalog);
  });
});

function fake(id: string, status: Partial<ProviderStatus> = {}): Provider {
  return {
    id,
    name: `Fake ${id}`,
    signIn: "sign in",
    tiers: { deep: ["big"], standard: ["mid"], light: ["small"] },
    features: {
      agentTools: true,
      streaming: true,
      keepsConversation: true,
      usageReport: true,
      nonInteractive: true,
    },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok", ...status }),
    models: () => Promise.resolve([{ id: "big", name: "Big" }]),
    efforts: () => [],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: () => new FakeModel({ turns: [] }),
  };
}
