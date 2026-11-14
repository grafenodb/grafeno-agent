import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import { MemorySession, ROOM, locusFor } from "../../src/memory/session.js";
import { detectProject } from "../../src/memory/project.js";
import { FakeModel } from "../../src/model/index.js";
import { FakeVault } from "./fake-vault.js";

const project = { name: "demo", path: "/work/demo" };

async function start(vault = new FakeVault()) {
  const session = await MemorySession.start({
    vault,
    project,
    knownSecrets: ["the-agents-key-123"],
  });
  return { vault, session };
}

describe("MemorySession.start", () => {
  it("makes the project's palace, room and node, and brings back what memory holds", async () => {
    const { vault, session } = await start();
    expect(vault.called("palace_create")).toEqual([expect.objectContaining({ name: "demo" })]);
    expect(vault.called("palace_create_room")).toEqual([
      expect.objectContaining({ palace: "demo", name: ROOM }),
    ]);
    expect(vault.called("remember")[0]).toMatchObject({ name: "demo", labels: ["Project"] });
    expect(vault.called("resume")).toEqual([{ about: session.projectId }]);
    expect(session.brief).toContain("The room holds: nothing yet.");
    expect(session.brief).toContain("first session");
  });

  it("brings back the project's latest checkpoint", async () => {
    const vault = new FakeVault({
      resume: () => ({
        text: "Summary: half of the parser is done. Next: error messages.",
        isError: false,
        data: { found: true },
      }),
    });
    const { session } = await start(vault);
    expect(session.brief).toContain("half of the parser is done");
    expect(session.systemPrompt("BASE")).toMatch(/^BASE\n\n## Memory/);
    expect(session.systemPrompt("BASE")).toContain("half of the parser is done");
  });

  it("fails clearly when memory refuses", async () => {
    const vault = new FakeVault({ palace_create: () => ({ text: "forbidden", isError: true }) });
    await expect(start(vault)).rejects.toThrow(/Memory refused: forbidden/);
  });
});

describe("MemorySession.beforeTurn", () => {
  it("puts what memory knows in front of the message, as data", async () => {
    const { vault, session } = await start();
    vault.memories.push({ id: "p", text: "The user prefers tabs over spaces.", labels: [] });
    expect(await session.beforeTurn("What indentation do I prefer?")).toBe(
      "<memory>\n- The user prefers tabs over spaces.\n</memory>\n\nWhat indentation do I prefer?",
    );
  });

  it("sends the message alone when memory has nothing, or cannot be reached", async () => {
    const { session } = await start();
    expect(await session.beforeTurn("hello there")).toBe("hello there");
    const broken = await start(
      new FakeVault({
        context: () => {
          throw new Error("down");
        },
      }),
    );
    expect(await broken.session.beforeTurn("hello there")).toBe("hello there");
  });
});

describe("the memory tools", () => {
  it("offers only the memory tools, in the agent's namespace", async () => {
    const { session } = await start();
    const tools = await session.tools();
    // The fake offers merge too: it is not one of the agent's tools.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "checkpoint",
      "context",
      "forget",
      "palace_anchor",
      "recall",
      "remember",
    ]);
    for (const tool of tools) {
      expect(tool.writes).toBe(false);
      expect(Object.keys(tool.inputSchema.properties as object)).not.toContain("namespace");
    }
  });

  it("anchors what the model remembers in the project's room, by kind", async () => {
    const { vault, session } = await start();
    const remember = (await session.tools()).find((t) => t.name === "remember");
    await remember?.run(
      { text: "Use Vitest.", labels: ["Decision"], namespace: "elsewhere" },
      { signal: new AbortController().signal },
    );
    const stored = vault.called("remember").at(-1);
    expect(stored).toEqual({
      text: "Use Vitest.",
      labels: ["Decision"],
      links: [{ label: "part_of", to: session.projectId }],
    });
    expect(vault.called("palace_anchor").at(-1)).toMatchObject({
      room: ROOM,
      palace: "demo",
      locus: "Decisions",
    });
  });

  it("refuses to store secrets, and never sends them to memory", async () => {
    const { vault, session } = await start();
    const remember = (await session.tools()).find((t) => t.name === "remember");
    const before = vault.calls.length;
    await expect(
      remember?.run(
        { text: "The agent key is the-agents-key-123" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/Not stored/);
    expect(vault.calls.length).toBe(before);
  });

  it("files checkpoints under the project, whatever the model says", async () => {
    const { vault, session } = await start();
    const checkpoint = (await session.tools()).find((t) => t.name === "checkpoint");
    const signal = new AbortController().signal;
    await checkpoint?.run({ summary: "Done for today." }, { signal });
    // Seen on real Claude: it passed the room's id as `about`.
    await checkpoint?.run({ summary: "More.", task: "mine", about: "the-room-id" }, { signal });
    expect(vault.called("checkpoint")).toEqual([
      { summary: "Done for today.", about: session.projectId, task: "demo: work" },
      { summary: "More.", about: session.projectId, task: "mine" },
    ]);
  });

  it("picks the place for each kind of memory", () => {
    expect(locusFor(["Preference"])).toBe("Preferences");
    expect(locusFor(["Question"])).toBe("Open questions");
    expect(locusFor(["Fact"])).toBe("Facts");
    expect(locusFor(undefined)).toBe("Notes");
  });
});

describe("a second session picks up the first (fake memory, fake model)", () => {
  it("remembers a preference and the checkpoint across sessions", async () => {
    let lastCheckpoint = "";
    const resumeLike = () =>
      lastCheckpoint === ""
        ? { text: "{}", isError: false, data: { found: false } }
        : { text: lastCheckpoint, isError: false, data: { found: true } };
    const shared = new FakeVault({
      resume: resumeLike,
      checkpoint: (args) => {
        lastCheckpoint = `Summary: ${String(args.summary)}`;
        return { text: '{"id":"cp1"}', isError: false };
      },
    });

    // Session 1: the user states a preference; the model stores it; then the checkpoint.
    const first = await MemorySession.start({ vault: shared, project });
    const agent1 = new Agent({
      model: new FakeModel({
        turns: [
          [
            {
              call: "remember",
              input: { text: "The user prefers tabs over spaces.", labels: ["Preference"] },
            },
            { say: "Noted." },
          ],
          [{ call: "checkpoint", input: { summary: "Set up the linter." } }, { say: "Saved." }],
        ],
      }),
      system: first.systemPrompt("BASE"),
      tools: new ToolRegistry(await first.tools()),
      prepare: (m) => first.beforeTurn(m),
    });
    await agent1.turn("I prefer tabs over spaces.");
    await agent1.turn(first.endOfSession());
    await agent1.close();

    // Session 2: nothing is said about the past; memory brings it back.
    const second = await MemorySession.start({ vault: shared, project });
    const model2 = new FakeModel({ turns: [[{ say: (c) => c.message }]] });
    const agent2 = new Agent({
      model: model2,
      system: second.systemPrompt("BASE"),
      tools: new ToolRegistry(await second.tools()),
      prepare: (m) => second.beforeTurn(m),
    });
    const turn = await agent2.turn("Do I prefer tabs or spaces?");
    expect(model2.conversations[0]?.system).toContain("Summary: Set up the linter.");
    expect(turn.result.text).toContain("The user prefers tabs over spaces.");
    await agent2.close();
  });
});

describe("detectProject", () => {
  it("names the project after the git repository it runs in", () => {
    const here = detectProject(process.cwd());
    expect(here.name).toBe("grafeno-agent");
    expect(detectProject(process.cwd(), "other").name).toBe("other");
  });
});
