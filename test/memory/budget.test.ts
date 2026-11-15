import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, parseLimits, RetrievalBudget } from "../../src/memory/budget.js";
import { MemorySession } from "../../src/memory/session.js";
import type { VaultAnswer } from "../../src/memory/vault.js";
import { FakeVault } from "./fake-vault.js";

const ok = (data: unknown): VaultAnswer => ({
  text: JSON.stringify(data, null, 2),
  isError: false,
  data,
});
const ID = (n: number) => `01a1dd99-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("RetrievalBudget: soft budgets", () => {
  it("asks Grafeno for no more than the lookup budget, and less when the model asks for less", () => {
    const budget = new RetrievalBudget({ lookupItems: 8, lookupTokens: 800 });
    expect(budget.admit("recall", { query: "x" })).toEqual({ args: { query: "x", limit: 8 } });
    expect(budget.admit("recall", { query: "x", limit: 50 })).toEqual({
      args: { query: "x", limit: 8 },
    });
    expect(budget.admit("recall", { query: "x", limit: 3 })).toEqual({
      args: { query: "x", limit: 3 },
    });
    expect(budget.admit("context", { query: "x", budget: 5000 })).toEqual({
      args: { query: "x", budget: 800 },
    });
  });

  it("stops bringing memory on its own once the session's budget is used, and says how often", () => {
    const budget = new RetrievalBudget({ sessionTokens: 10 });
    expect(budget.automaticAllowed()).toBe(true);
    budget.countAutomatic("x".repeat(60));
    expect(budget.automaticAllowed()).toBe(false);
    expect(budget.stats).toMatchObject({ automatic: 1, automaticTokens: 15, automaticSkipped: 1 });
  });

  it("leaves storing alone: only lookups are counted and limited", () => {
    const budget = new RetrievalBudget({ callsPerTurn: 1 });
    for (let i = 0; i < 5; i++) {
      expect(budget.admit("remember", { text: "t" })).toEqual({ args: { text: "t" } });
    }
    expect(budget.stats.calls).toBe(0);
  });
});

describe("RetrievalBudget: hard limits", () => {
  it("refuses lookups past the turn's limit, until the next turn", () => {
    const budget = new RetrievalBudget({ callsPerTurn: 2 });
    budget.admit("recall", { query: "a" });
    budget.admit("get_node", { id: "x" });
    const refused = budget.admit("recall", { query: "c" });
    expect("refused" in refused && refused.refused).toMatch(/budget for this turn/);
    budget.startTurn();
    expect(budget.admit("recall", { query: "d" })).toHaveProperty("args");
    expect(budget.stats.refused).toBe(1);
  });

  it("allows one deep look at the palace per turn", () => {
    const budget = new RetrievalBudget();
    expect(budget.admit("palace_map", {})).toHaveProperty("args");
    const deep = budget.admit("palace_walk", { topic: "x" });
    expect("refused" in deep && deep.refused).toMatch(/One deep look/);
    expect(budget.admit("recall", { query: "x" })).toHaveProperty("args");
    expect(budget.stats.deepCalls).toBe(1);
  });

  it("cuts an answer past the size limit at a line, and names the ids it left out", () => {
    const budget = new RetrievalBudget({ resultChars: 200 });
    const lines = Array.from({ length: 20 }, (_, i) => `room ${String(i)}: ${ID(i)}`).join("\n");
    const text = budget.fit("palace_map", { text: lines, isError: false });
    expect(text.length).toBeLessThan(200 + 1200);
    expect(text).toMatch(/\(cut at 200 characters: \d+ more\. Left out, by id: /);
    expect(text).toContain(ID(19));
    expect(text.split("\n")[0]).toBe(`room 0: ${ID(0)}`);
    expect(budget.stats.cut).toBe(1);
  });
});

describe("RetrievalBudget: answers fit for the context", () => {
  it("writes a search's results as compact lines, without the scores and reasons", () => {
    const budget = new RetrievalBudget();
    const answer = ok({
      results: [
        {
          id: "m1",
          name: "Precedence",
          labels: ["Decision"],
          text: "Precedence: follows C.",
          score: 1.7,
          why: ["text match #1"],
          justification: { archived: false },
        },
      ],
    });
    const text = budget.fit("recall", answer);
    expect(text).toBe("[m1] Precedence (Decision): follows C.");
    expect(text.length).toBeLessThan(answer.text.length / 3);
  });

  it("shows a memory once per session: after that, by id only", () => {
    const budget = new RetrievalBudget();
    budget.seen(["m0"]); // In the compact resume.
    const answer = ok({
      results: [
        { id: "m0", name: "A", text: "From the resume." },
        { id: "m1", name: "B", text: "New." },
      ],
    });
    expect(budget.fit("recall", answer)).toBe("[m0] A: shown earlier this session\n[m1] B: New.");
    expect(budget.fit("recall", answer)).toBe(
      "[m0] A: shown earlier this session\n[m1] B: shown earlier this session",
    );
    expect(budget.stats).toMatchObject({ itemsReturned: 1, itemsDeduplicated: 3 });
  });

  it("writes other structured answers as compact JSON, and leaves errors and stores as they are", () => {
    const budget = new RetrievalBudget();
    const data = { palace: { name: "p", rooms: [{ id: "r", loci: [] }] } };
    expect(budget.fit("palace_map", ok(data))).toBe(JSON.stringify(data));
    expect(budget.fit("recall", { text: "refused", isError: true })).toBe("refused");
    expect(budget.fit("remember", ok({ id: "m1" }))).toBe(JSON.stringify({ id: "m1" }, null, 2));
  });
});

describe("parseLimits (AGENT_MEMORY_BUDGET)", () => {
  it("reads name=value pairs and names what is wrong", () => {
    expect(parseLimits("checkpoint=400, session=0").limits).toEqual({
      checkpoint: 400,
    });
    expect(parseLimits("sessionTokens=0,callsPerTurn=3").limits).toEqual({
      sessionTokens: 0,
      callsPerTurn: 3,
    });
    expect(parseLimits("session=0").problems[0]).toMatch(/unknown limit "session"/);
    expect(parseLimits("checkpoint=-1").problems[0]).toMatch(/whole number/);
    expect(Object.keys(DEFAULT_LIMITS)).toContain("resultChars");
  });
});

describe("the budget in a memory session", () => {
  const project = { name: "demo", path: "/work/demo" };
  const signal = new AbortController().signal;

  it("refuses the model's lookups past the turn's limit, with a reason it can act on", async () => {
    const session = await MemorySession.start({
      vault: new FakeVault(),
      project,
      limits: { callsPerTurn: 1 },
    });
    const recall = (await session.tools()).find((t) => t.name === "recall");
    await session.beforeTurn("hello");
    await recall?.run({ query: "a" }, { signal });
    await expect(recall?.run({ query: "b" }, { signal })).rejects.toThrow(/budget for this turn/);
    await session.beforeTurn("next message");
    await expect(recall?.run({ query: "c" }, { signal })).resolves.toBeDefined();
  });

  it("stops looking memory up before each message once the session's budget is used", async () => {
    const vault = new FakeVault();
    const session = await MemorySession.start({ vault, project, limits: { sessionTokens: 25 } });
    vault.memories.push({ id: "p", text: "The user prefers tabs over spaces.", labels: [] });
    const first = await session.beforeTurn("What indentation do I prefer?");
    expect(first).toContain("<memory>");
    const before = vault.called("context").length;
    expect(await session.beforeTurn("What indentation do I prefer?")).toBe(
      "What indentation do I prefer?",
    );
    expect(vault.called("context").length).toBe(before);
    expect(session.retrieval.stats.automaticSkipped).toBe(1);
  });

  it("passes the compact resume's limits on, and counts the resume as memory brought on its own", async () => {
    const vault = new FakeVault();
    const session = await MemorySession.start({
      vault,
      project,
      limits: { checkpoint: 100 },
    });
    expect(session.retrieval.limits.checkpoint).toBe(100);
    expect(session.retrieval.stats.automatic).toBe(1);
    expect(session.retrieval.stats.automaticTokens).toBe(session.resumed?.stats.totalTokens);
  });
});
