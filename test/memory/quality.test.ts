import { describe, expect, it } from "vitest";
import { normalize, similarity } from "../../src/memory/quality.js";
import { MemorySession } from "../../src/memory/session.js";
import { describeUpkeep, upkeep } from "../../src/memory/upkeep.js";
import { FakeVault } from "./fake-vault.js";

const signal = new AbortController().signal;
const project = { name: "demo" };

async function tool(vault: FakeVault, name: string) {
  const session = await MemorySession.start({ vault, project });
  const found = (await session.tools()).find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return { session, run: (input: Record<string, unknown>) => found.run(input, { signal }) };
}

describe("similarity", () => {
  it("compares words, not case, accents or punctuation", () => {
    expect(normalize("  Usá PNPM, ¡siempre!  ")).toBe("usa pnpm siempre");
    expect(similarity("The project uses pnpm.", "the project uses PNPM")).toBe(1);
    expect(similarity("The project uses pnpm.", "The project uses yarn.")).toBeLessThan(0.8);
  });
});

describe("the duplicate guard", () => {
  it("does not store what memory already holds, and says where it is", async () => {
    const vault = new FakeVault();
    const { run } = await tool(vault, "remember");
    await run({ text: "The project uses pnpm as its package manager.", labels: ["Fact"] });
    const before = vault.called("remember").length;
    const answer = await run({ text: "the project uses PNPM as its package manager" });
    expect(answer).toMatch(/^Already in memory, not stored again: m\d+/);
    expect(vault.called("remember").length).toBe(before);
  });

  it("stores what is different", async () => {
    const vault = new FakeVault();
    const { run } = await tool(vault, "remember");
    await run({ text: "The project uses pnpm as its package manager." });
    const answer = await run({ text: "The tests run with Vitest in watch mode." });
    expect(answer).not.toMatch(/Already in memory/);
  });

  it("lets a memory be updated by its own name", async () => {
    const vault = new FakeVault({
      recall: () => ({
        text: "",
        isError: false,
        data: { results: [{ id: "n1", name: "Package manager", text: "Package manager: pnpm" }] },
      }),
    });
    const { run } = await tool(vault, "remember");
    const answer = await run({ name: "Package manager", text: "pnpm" });
    expect(answer).not.toMatch(/Already in memory/);
  });

  it("sees through the name Grafeno puts in front of a named memory's text", async () => {
    const vault = new FakeVault({
      recall: () => ({
        text: "",
        isError: false,
        data: {
          results: [
            {
              id: "n1",
              name: "Indentation",
              text: "Indentation: The user prefers tabs over spaces.",
            },
          ],
        },
      }),
    });
    const { run } = await tool(vault, "remember");
    expect(await run({ text: "The user prefers tabs over spaces." })).toMatch(/Already in memory/);
  });
});

describe("forget", () => {
  it("never deletes a memory: it points to feedback instead", async () => {
    const vault = new FakeVault(); // get_node answers: the id is a node
    const { run } = await tool(vault, "forget");
    await expect(run({ id: "m1" })).rejects.toThrow(/feedback "obsolete"/);
    expect(vault.called("forget")).toEqual([]);
  });

  it("closes a fact that ended, and never erases one", async () => {
    const vault = new FakeVault({ get_node: () => ({ text: "no node", isError: true }) });
    const { run } = await tool(vault, "forget");
    await run({ id: "f1" });
    expect(vault.called("forget")).toEqual([{ id: "f1", mode: "invalidate" }]);
    await expect(run({ id: "f1", mode: "delete" })).rejects.toThrow(/not erased/);
  });
});

describe("upkeep", () => {
  const healthy = {
    maintain: () => ({
      text: "",
      isError: false,
      data: { duplicates: [], duplicate_facts: [], superseded: [], consolidation: [] },
    }),
    palace_review: () => ({ text: "", isError: false, data: { proposals: [] } }),
    contradictions: () => ({ text: "", isError: false, data: { contradictions: [] } }),
  };

  it("says memory is in order when nothing needs fixing", async () => {
    const report = await upkeep({ vault: new FakeVault(healthy), palace: "demo", projectId: "p" });
    expect(report).toEqual({ items: [], clean: true });
    expect(describeUpkeep(report)).toBe("Memory is in order: nothing to fix.");
  });

  it("never calls memory in order when a check cannot run", async () => {
    const vault = new FakeVault({
      ...healthy,
      maintain: () => ({ text: "denied", isError: true }),
    });
    const report = await upkeep({ vault, palace: "demo", projectId: "p" });
    expect(report.items.map((i) => i.kind)).toEqual(["check_failed"]);
    expect(report.clean).toBe(false);
  });

  it("reports what needs judgment, and changes nothing without --apply", async () => {
    const vault = new FakeVault({
      ...healthy,
      maintain: () => ({
        text: "",
        isError: false,
        data: {
          duplicates: [{ a: { id: "a", text: "x" }, b: { id: "b", text: "x" }, score: 0.97 }],
          superseded: [{ older: { id: "o", text: "npm" }, newer: { id: "n", text: "pnpm" } }],
        },
      }),
      contradictions: () => ({
        text: "",
        isError: false,
        data: {
          contradictions: [{ action: "flagged", new: "a", old: "b" }, { action: "invalidated" }],
        },
      }),
      palace_review: () => ({
        text: "",
        isError: false,
        data: {
          proposals: [
            { kind: "unconnected_room", name: "General", room: "r1", how: "relate them" },
          ],
        },
      }),
    });
    const report = await upkeep({ vault, palace: "demo", projectId: "p" });
    expect(report.items.map((i) => i.kind)).toEqual([
      "duplicate",
      "superseded",
      "palace:unconnected_room",
      "contradiction",
    ]);
    expect(report.clean).toBe(false);
    expect(vault.called("feedback")).toEqual([]);
    expect(vault.called("relate")).toEqual([]);
  });

  it("with --apply, links a loose room's memories to the project, saying why", async () => {
    const vault = new FakeVault({
      ...healthy,
      palace_review: () => ({
        text: "",
        isError: false,
        data: { proposals: [{ kind: "unconnected_room", name: "General", room: "r1" }] },
      }),
      palace_map: () => ({
        text: "",
        isError: false,
        data: { room: { loci: [{ memories: [{ id: "p" }, { id: "m1" }, { id: "m2" }] }] } },
      }),
    });
    const report = await upkeep({ vault, palace: "demo", projectId: "p", apply: true });
    expect(vault.called("relate").map((r) => [r.from, r.label, r.to])).toEqual([
      ["m1", "part_of", "p"],
      ["m2", "part_of", "p"],
    ]);
    expect(report.items[0]?.done).toBe("linked 2 memories to the project (part_of)");
    expect(report.clean).toBe(true);
  });
});

describe("when upkeep last ran", () => {
  it("is read from the project's node, and recorded there", async () => {
    let props: Record<string, unknown> = {};
    const vault = new FakeVault({
      get_node: () => ({ text: "", isError: false, data: { id: "p", props } }),
      update: (args) => {
        props = { ...props, ...(args.props as Record<string, unknown>) };
        return { text: "{}", isError: false };
      },
    });
    const session = await MemorySession.start({ vault, project });
    expect(await session.lastUpkeep()).toBeUndefined();
    await session.markUpkeep(new Date("2026-11-14T10:00:00Z"));
    expect(vault.called("update").at(-1)).toEqual({
      id: session.projectId,
      props: { last_upkeep: "2026-11-14T10:00:00.000Z" },
    });
    expect((await session.lastUpkeep())?.toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });
});
