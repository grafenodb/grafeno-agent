import { describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embed/types.js";
import { packCheckpoint } from "../../src/memory/checkpoint.js";
import { cosine } from "../../src/memory/quality.js";
import { MemorySession } from "../../src/memory/session.js";
import type { VaultAnswer } from "../../src/memory/vault.js";
import { FakeVault } from "./fake-vault.js";

const signal = new AbortController().signal;
const project = { name: "demo", path: "/work/demo" };
const ok = (data: unknown): VaultAnswer => ({ text: JSON.stringify(data), isError: false, data });

async function start(
  vault: FakeVault,
  extra: Partial<Parameters<typeof MemorySession.start>[0]> = {},
) {
  const session = await MemorySession.start({ vault, project, ...extra });
  const tools = await session.tools();
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(input, { signal });
  };
  return { session, run };
}

describe("revise: a memory that changed, in one call", () => {
  it("stores the new version from the old one, supersedes it with the reason, marks it obsolete and anchors it", async () => {
    const vault = new FakeVault({
      get_node: () => ok({ id: "old", labels: ["Memory", "Decision"] }),
    });
    const { session, run } = await start(vault);
    const answer = await run("revise", {
      old: "old",
      text: "Workers run in containers, one per task.",
      reason: "Worktrees were not isolated enough.",
    });
    const made = vault.called("remember").at(-1);
    expect(made).toMatchObject({
      text: "Workers run in containers, one per task.",
      labels: ["Decision"],
      sources: ["old"],
      links: [{ label: "part_of", to: session.projectId }],
    });
    const newId = session.stored.at(-1);
    expect(vault.called("relate").at(-1)).toEqual({
      from: newId,
      label: "supersedes",
      to: "old",
      reason: "Worktrees were not isolated enough.",
    });
    expect(vault.called("feedback")).toEqual([
      { id: "old", verdict: "obsolete", note: "Worktrees were not isolated enough." },
    ]);
    expect(vault.called("palace_anchor").at(-1)).toMatchObject({
      memory: newId,
      locus: "Decisions",
    });
    expect(answer).toMatch(/supersedes old, which is marked obsolete and kept for its history/);
  });

  it("does not mark another agent's memory, with an own-only key: the supersedes relation says it", async () => {
    const vault = new FakeVault({
      get_node: () => ok({ id: "old", labels: ["Fact"], provenance: { recorded_by: "agent-b" } }),
    });
    const { run } = await start(vault, { agent: { name: "agent-a", ownOnly: true } });
    const answer = await run("revise", { old: "old", text: "New fact.", reason: "Changed." });
    expect(vault.called("feedback")).toEqual([]);
    expect(vault.called("relate").at(-1)).toMatchObject({ label: "supersedes", to: "old" });
    expect(answer).toMatch(/recorded by another agent \(agent-b\), so it is not marked/);
  });

  it("refuses a missing memory and secrets", async () => {
    const vault = new FakeVault({ get_node: () => ({ text: "not found", isError: true }) });
    const { run } = await start(vault, { knownSecrets: ["gk_secret_value_123"] });
    await expect(run("revise", { old: "nope", text: "x", reason: "y" })).rejects.toThrow(
      /No memory nope to revise/,
    );
    await expect(
      run("revise", { old: "nope", text: "key gk_secret_value_123", reason: "y" }),
    ).rejects.toThrow();
    expect(vault.called("remember").some((r) => String(r.text).includes("gk_secret"))).toBe(false);
  });
});

/** Vectors by topic, so closeness is under the test's control. */
function topicEmbedder(): Embedder {
  const vector = (text: string): number[] =>
    /npm|pnpm|packages/i.test(text)
      ? [1, 0.05, 0]
      : /tabs|spaces/i.test(text)
        ? [0, 1, 0]
        : [0, 0, 1];
  return {
    name: "topics",
    dimension: 3,
    embed: (texts) => Promise.resolve(texts.map(vector)),
  };
}

describe("storing what is close in meaning", () => {
  it("tells the model of a close memory instead of storing, and stores when it says it is distinct", async () => {
    const vault = new FakeVault();
    const { run } = await start(vault, { embedder: topicEmbedder() });
    await run("remember", {
      text: "This project installs its packages with npm.",
      labels: ["Fact"],
    });
    const before = vault.called("remember").length;
    const told = await run("remember", {
      text: "Packages here come from pnpm now.",
      labels: ["Fact"],
    });
    expect(told).toMatch(/^Not stored yet: memory m\d+ .* is close in meaning/);
    expect(told).toMatch(/call revise with old "m\d+"/);
    expect(vault.called("remember").length).toBe(before);

    await run("remember", {
      text: "Packages here come from pnpm now.",
      labels: ["Fact"],
      distinct: true,
    });
    expect(vault.called("remember").length).toBe(before + 1);
    expect(vault.called("remember").at(-1)).not.toHaveProperty("distinct");
  });

  it("stores what is not close, and works without an embedder as before", async () => {
    const vault = new FakeVault();
    const { run } = await start(vault, { embedder: topicEmbedder() });
    await run("remember", { text: "This project installs its packages with npm." });
    const answer = await run("remember", { text: "The user prefers tabs over spaces." });
    expect(answer).not.toMatch(/Not stored yet/);

    const plain = new FakeVault();
    const words = await start(plain);
    await words.run("remember", { text: "This project installs its packages with npm." });
    expect(await words.run("remember", { text: "Packages here come from pnpm now." })).not.toMatch(
      /Not stored yet/,
    );
  });

  it("measures closeness as the cosine of the vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe("carrying a checkpoint forward before a conversation is renewed", () => {
  const latest = {
    ...packCheckpoint({
      task: "demo: work",
      goal: "Ship the parser",
      status: "blocked",
      summary: "Lexer done.\nConversation renewed: an earlier pause.",
      next_action: "Write the grammar",
      next: ["Docs"],
      blocked: ["Waits on precedence"],
      errors: ["1 failing test"],
      decisions: ["Hand-written parser"],
      files: ["src/parser.ts"],
      memory_refs: ["m-old"],
      git_ref: "abc1234",
    }),
    id: "cp1",
  };

  it("keeps the state, adds what was stored since, and says why", async () => {
    const vault = new FakeVault({
      resume: () => ok({ found: true, checkpoint: latest }),
      checkpoint: () => ok({ id: "cp2" }),
    });
    const { session, run } = await start(vault, { gitRef: () => Promise.resolve("def5678") });
    await run("remember", { text: "Pratt parsing for expressions.", labels: ["Decision"] });
    expect(await session.carryCheckpoint("90 minutes without a message")).toBe(true);
    const saved = vault.called("checkpoint").at(-1) ?? {};
    expect(saved).toMatchObject({
      task: "demo: work",
      next: ["Write the grammar", "Docs"],
      decisions: ["Hand-written parser"],
      files: ["src/parser.ts"],
      about: session.projectId,
    });
    const summary = String(saved.summary);
    // The earlier renewal line is replaced, not stacked.
    expect(summary.match(/Conversation renewed/g)).toHaveLength(1);
    expect(summary).toContain("Lexer done.\nConversation renewed: 90 minutes without a message.");
    expect(summary).toContain('"status":"blocked"');
    expect(summary).toContain('"blocked":["Waits on precedence"]');
    expect(summary).toContain('"errors":["1 failing test"]');
    expect(summary).toMatch(/"memory_refs":\["m-old","m\d+"\]/);
    expect(summary).toContain('"git_ref":"def5678"');
  });

  it("saves nothing when nothing changed since the latest checkpoint", async () => {
    const vault = new FakeVault({ resume: () => ok({ found: true, checkpoint: latest }) });
    const { session } = await start(vault, { gitRef: () => Promise.resolve("abc1234") });
    expect(await session.carryCheckpoint("a pause")).toBe(false);
    expect(vault.called("checkpoint")).toEqual([]);
  });

  it("builds the compact resume again, and forgets what the old conversation was shown", async () => {
    const vault = new FakeVault();
    const { session } = await start(vault);
    session.retrieval.seen(["m1"]);
    const first = session.brief;
    const resumed = await session.refreshResume();
    expect(resumed?.text).toBe(first);
    expect(
      session.retrieval.fit("recall", ok({ results: [{ id: "m1", name: "A", text: "Again." }] })),
    ).toBe("[m1] A: Again.");
  });
});
