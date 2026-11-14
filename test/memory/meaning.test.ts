import { describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embed/types.js";
import { MemorySession } from "../../src/memory/session.js";
import { FakeVault } from "./fake-vault.js";

const signal = new AbortController().signal;
const project = { name: "demo" };

/** Vectors that tell what was embedded and how: [length, 1 for a query]. */
function fakeEmbedder(fail = false): Embedder & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    dimension: 2,
    calls,
    embed: (texts, kind) => {
      calls.push(...texts.map((t) => `${kind}:${t}`));
      if (fail) return Promise.reject(new Error("model missing"));
      return Promise.resolve(texts.map((t) => [t.length, kind === "query" ? 1 : 0]));
    },
  };
}

async function start(embedder?: Embedder) {
  const vault = new FakeVault();
  const session = await MemorySession.start({ vault, project, ...(embedder ? { embedder } : {}) });
  const tools = await session.tools();
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(input, { signal });
  };
  return { vault, session, tools, run };
}

describe("meaning in memory", () => {
  it("stores each memory with the vector of its text", async () => {
    const { vault, run } = await start(fakeEmbedder());
    await run("remember", { text: "Use pnpm." });
    expect(vault.called("remember").at(-1)?.embedding).toEqual([9, 0]);
  });

  it("asks memory with the vector of the question", async () => {
    const embedder = fakeEmbedder();
    const { vault, session, run } = await start(embedder);
    await session.beforeTurn("which tool?");
    expect(vault.called("context").at(-1)).toMatchObject({ embedding: [11, 1] });
    await run("recall", { query: "pnpm" });
    expect(vault.called("recall").at(-1)).toMatchObject({ embedding: [4, 1] });
    expect(embedder.calls).toContain("query:which tool?");
  });

  it("does not let the model send vectors", async () => {
    const { vault, tools, run } = await start(fakeEmbedder());
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties as object)).not.toContain("embedding");
    }
    await run("recall", { query: "pnpm", embedding: [0.5, 0.5] });
    expect(vault.called("recall").at(-1)?.embedding).toEqual([4, 1]);
  });

  it("works by words alone without an embedder, or when it fails", async () => {
    for (const embedder of [undefined, fakeEmbedder(true)]) {
      const { vault, session, run } = await start(embedder);
      await run("remember", { text: "Use pnpm." });
      expect(vault.called("remember").at(-1)).not.toHaveProperty("embedding");
      expect(await session.beforeTurn("hello there")).toBe("hello there");
      expect(vault.called("context").at(-1)).not.toHaveProperty("embedding");
    }
  });
});
