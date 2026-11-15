import { describe, expect, it } from "vitest";
import { lightModel, mostRoom, readTriage, triage, TRIAGE_SYSTEM } from "../../src/app/triage.js";
import { FakeModel } from "../../src/model/index.js";
import type { Provider, ProviderUsage } from "../../src/providers/types.js";

describe("readTriage", () => {
  it("reads the light model's line, strictly", () => {
    expect(readTriage("ORCHESTRATE: backend, frontend, tests and docs")).toEqual({
      route: "orchestrate",
      reason: "backend, frontend, tests and docs",
    });
    expect(readTriage("DIRECT — a question about one file")).toEqual({
      route: "direct",
      reason: "a question about one file",
    });
    expect(readTriage("**orchestrate**: several parts\nmore text").route).toBe("orchestrate");
  });

  it("answers directly when the line is unclear: the cheap way", () => {
    expect(readTriage("I think this needs a plan.")).toEqual({
      route: "direct",
      reason: "the triage was unclear",
    });
    expect(readTriage("")).toMatchObject({ route: "direct" });
  });
});

describe("triage", () => {
  it("asks a light model once, with no tools, and says which model decided", async () => {
    const model = new FakeModel({ turns: [[{ say: "ORCHESTRATE: an API, a UI and tests" }]] });
    const decision = await triage("Build the orders API with a UI and tests", model, "codex/luna");
    expect(decision).toEqual({
      route: "orchestrate",
      reason: "an API, a UI and tests",
      by: "codex/luna",
    });
    expect(model.conversations).toHaveLength(1);
    expect(model.conversations[0]?.system).toBe(TRIAGE_SYSTEM);
    expect(model.conversations[0]?.messages[0]).toContain("Build the orders API");
  });

  it("answers directly when the model fails", async () => {
    const model = new FakeModel({ turns: [[{ fail: "unavailable", message: "down" }]] });
    expect(await triage("anything", model)).toEqual({
      route: "direct",
      reason: "the triage could not run",
    });
  });
});

const usage = (used: number): ProviderUsage => ({
  limits: [{ label: "5 hours", used }],
  at: new Date(),
});
const provider = (id: string, light?: string): Provider =>
  ({
    id,
    name: id,
    ...(light ? { tiers: { deep: [], standard: [], light: [light] } } : {}),
  }) as unknown as Provider;

describe("the pool's choice in General Auto", () => {
  it("takes the provider with the most room, never one at its limit", () => {
    const a = { provider: provider("a"), usage: usage(0.7) };
    const b = { provider: provider("b"), usage: usage(0.2) };
    const c = { provider: provider("c"), usage: usage(0.97) };
    expect(mostRoom([a, b, c])?.provider.id).toBe("b");
    expect(mostRoom([c])).toBeUndefined();
    expect(mostRoom([{ provider: provider("x") }, { provider: provider("y") }])?.provider.id).toBe(
      "x",
    );
  });

  it("triages with a provider's lightest model, as its own tiers name it", () => {
    expect(lightModel(provider("codex", "gpt-6-luna"))).toBe("gpt-6-luna");
    expect(lightModel(provider("other"))).toBeUndefined();
  });
});
