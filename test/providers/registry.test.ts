import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import { CapabilityRegistry } from "../../src/providers/registry.js";
import type { Provider, ProviderStatus } from "../../src/providers/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-registry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A provider that counts how often its models are read. */
function fake(id: string, status: Partial<ProviderStatus> = {}) {
  const state = { version: "1.0", modelReads: 0, status: { ...status } };
  const provider: Provider = {
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
    status: () =>
      Promise.resolve({
        installed: true,
        signedIn: true,
        version: state.version,
        detail: "ok",
        ...state.status,
      }),
    models: () => {
      state.modelReads++;
      return Promise.resolve([
        { id: "big", name: "Big" },
        { id: "small", name: "Small" },
      ]);
    },
    efforts: (model) => (model === "small" ? ["low"] : ["low", "high"]),
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () => new FakeModel({ turns: [[{ say: "" }]] }),
  };
  return { provider, state };
}

describe("CapabilityRegistry", () => {
  it("reads a provider's models once, with their efforts, and keeps them with their date", async () => {
    const { provider, state } = fake("a");
    const file = join(dir, "capabilities.json");
    const at = new Date("2026-11-15T10:00:00Z");
    const registry = new CapabilityRegistry({ providers: [provider], file, now: () => at });
    const caps = await registry.capabilities("a");
    expect(caps).toMatchObject({
      id: "a",
      installed: true,
      signedIn: true,
      version: "1.0",
      checked: at.toISOString(),
      models: [
        { id: "big", name: "Big", efforts: ["low", "high"] },
        { id: "small", name: "Small", efforts: ["low"] },
      ],
      tiers: { light: ["small"] },
    });
    await registry.capabilities("a");
    expect(state.modelReads).toBe(1);
    // Kept on disk: a new registry (a new process) does not read them again.
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { version?: string }>;
    expect(saved.a?.version).toBe("1.0");
    await new CapabilityRegistry({ providers: [provider], file, now: () => at }).capabilities("a");
    expect(state.modelReads).toBe(1);
  });

  it("reads the models again when they are old, or when the provider's version changed", async () => {
    const { provider, state } = fake("a");
    let now = new Date("2026-11-15T10:00:00Z");
    const registry = new CapabilityRegistry({
      providers: [provider],
      now: () => now,
      maxAgeMs: 60_000,
      statusAgeMs: 0,
    });
    await registry.capabilities("a");
    now = new Date("2026-11-15T10:02:00Z");
    await registry.capabilities("a");
    expect(state.modelReads).toBe(2);
    state.version = "2.0";
    await registry.capabilities("a");
    expect(state.modelReads).toBe(3);
    await registry.capabilities("a", { refresh: true });
    expect(state.modelReads).toBe(4);
  });

  it("marks a provider not installed or signed out, and does not offer it", async () => {
    const ready = fake("ready").provider;
    const missing = fake("missing", { installed: false, signedIn: false, detail: "install it" });
    const out = fake("out", { signedIn: false, detail: "sign in" });
    const registry = new CapabilityRegistry({
      providers: [ready, missing.provider, out.provider],
    });
    expect((await registry.capabilities("missing")).installed).toBe(false);
    expect(missing.state.modelReads).toBe(0); // nothing is asked of a missing provider
    expect((await registry.ready()).map((c) => c.id)).toEqual(["ready"]);
  });

  it("sets a provider aside until it may be tried again", async () => {
    const { provider } = fake("a");
    const other = fake("b").provider;
    let now = new Date("2026-11-15T10:00:00Z");
    const registry = new CapabilityRegistry({ providers: [provider, other], now: () => now });
    registry.setAside("a", { reason: "its limit", until: new Date("2026-11-15T11:00:00Z") });
    expect(registry.unavailable("a")?.reason).toBe("its limit");
    expect((await registry.ready()).map((c) => c.id)).toEqual(["b"]);
    now = new Date("2026-11-15T11:00:01Z");
    expect(registry.unavailable("a")).toBeUndefined();
    expect((await registry.ready()).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("says a provider whose status fails is not installed, with why", async () => {
    const { provider } = fake("a");
    const broken: Provider = { ...provider, status: () => Promise.reject(new Error("crashed")) };
    const caps = await new CapabilityRegistry({ providers: [broken] }).capabilities("a");
    expect(caps).toMatchObject({ installed: false, signedIn: false, detail: "crashed" });
  });
});
