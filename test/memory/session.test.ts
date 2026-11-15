import { basename } from "node:path";
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
    // A compact resume: the palace is not walked.
    expect(vault.called("palace_enter")).toEqual([]);
    expect(session.brief).toContain("first session");
    expect(session.resumed?.stats.totalTokens).toBeLessThan(100);
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
      "revise",
      "update",
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
    const empty = { done: [], next: [], decisions: [], files: [] };
    expect(vault.called("checkpoint")).toEqual([
      {
        ...empty,
        summary: 'Done for today.\nstate: {"v":1,"status":"in_progress"}',
        about: session.projectId,
        task: "demo: work",
      },
      {
        ...empty,
        summary: 'More.\nstate: {"v":1,"status":"in_progress"}',
        about: session.projectId,
        task: "mine",
      },
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
    // The checkout's folder, whatever it is called (a clone or a worktree is not always "grafeno-agent").
    expect(here.path).toBe(process.cwd());
    expect(here.name).toBe(basename(process.cwd()));
    expect(detectProject(process.cwd(), "other").name).toBe("other");
  });
});

/** An answer of memory, as data. */
const ok = (data: unknown) => ({ text: JSON.stringify(data), isError: false, data });
const context = { signal: new AbortController().signal };

describe("several agents", () => {
  const review = { name: "grafeno-agent-review", ownOnly: true };

  async function startAs(vault: FakeVault, palace?: "shared" | "own") {
    return MemorySession.start({ vault, project, agent: review, ...(palace ? { palace } : {}) });
  }

  it("uses the project's node another agent made, without changing it", async () => {
    const vault = new FakeVault({
      recall: (args) =>
        ok({
          results:
            Array.isArray(args.labels) && args.labels.includes("Project")
              ? [{ id: "p-by-other", name: "demo", labels: ["Project"], text: "demo" }]
              : [],
        }),
    });
    const session = await startAs(vault);
    expect(session.projectId).toBe("p-by-other");
    expect(vault.called("remember").map((a) => a.name)).toEqual(["grafeno-agent-review"]);
    expect(vault.called("relate")).toEqual([
      { from: session.agentId, label: "works_on", to: "p-by-other" },
    ]);
  });

  it("finds the project's node when another agent made it at the same moment", async () => {
    let made = false;
    const vault = new FakeVault({
      recall: () =>
        ok({
          results: made ? [{ id: "p-race", name: "Demo", labels: ["Project"], text: "demo" }] : [],
        }),
      remember: (args) => {
        if (args.name === "demo") {
          made = true;
          return {
            text: 'forbidden: grafeno-agent-review may only change what it recorded, and node "demo" was recorded by grafeno-agent-dev',
            isError: true,
          };
        }
        return { text: JSON.stringify({ id: "a1" }), isError: false };
      },
    });
    expect((await startAs(vault)).projectId).toBe("p-race");
  });

  it("keeps a palace of its own when asked", async () => {
    const vault = new FakeVault();
    const session = await startAs(vault, "own");
    expect(session.palace).toBe("demo · grafeno-agent-review");
    expect(vault.called("palace_create_room")[0]).toMatchObject({
      palace: "demo · grafeno-agent-review",
    });
    await expect(
      MemorySession.start({ vault: new FakeVault(), project, palace: "own" }),
    ).rejects.toThrow(/needs the agent's name/);
  });

  it("tells the model who it is and what it may change", async () => {
    const session = await startAs(new FakeVault());
    const prompt = session.systemPrompt("BASE");
    expect(prompt).toContain('You are the agent "grafeno-agent-review"');
    expect(prompt).toContain("change, mark (feedback) or forget only what you recorded yourself");
    expect(prompt).toContain("supersedes");
  });

  it("saves checkpoints under its own name and task", async () => {
    const vault = new FakeVault();
    const session = await startAs(vault);
    const checkpoint = (await session.tools()).find((t) => t.name === "checkpoint");
    await checkpoint?.run({ summary: "done", agent: "grafeno-agent-dev" }, context);
    expect(vault.called("checkpoint")[0]).toMatchObject({
      agent: "grafeno-agent-review",
      task: "demo: work of grafeno-agent-review",
      about: session.projectId,
    });
  });

  it("brings back its own checkpoint and another agent's newer one", async () => {
    const vault = new FakeVault({
      resume: (args) =>
        args.agent === "grafeno-agent-review"
          ? ok({
              found: true,
              checkpoint: { id: "c1", agent: "grafeno-agent-review", task: "t", summary: "MINE" },
            })
          : ok({
              found: true,
              checkpoint: { id: "c2", agent: "grafeno-agent-dev", task: "t", summary: "THEIRS" },
            }),
    });
    const session = await startAs(vault);
    expect(session.brief).toMatch(/checkpoint c1, by grafeno-agent-review[\s\S]*Summary: MINE/);
    expect(session.brief).toMatch(/by another agent \(grafeno-agent-dev\)[\s\S]*THEIRS/);
  });

  it("explains a refusal to change another agent's memory", async () => {
    const vault = new FakeVault({
      update: () => ({
        text: 'forbidden: grafeno-agent-review may only change what it recorded, and node "x" was recorded by grafeno-agent-dev',
        isError: true,
      }),
    });
    const session = await startAs(vault);
    const update = (await session.tools()).find((t) => t.name === "update");
    expect(update).toBeDefined();
    await expect(update?.run({ id: "x", text: "changed" }, context)).rejects.toThrow(
      /relate it to that one with supersedes/,
    );
  });

  it("says when what it would store was recorded by another agent", async () => {
    const vault = new FakeVault({
      get_node: () => ok({ provenance: { recorded_by: "grafeno-agent-dev" } }),
    });
    const session = await startAs(vault);
    vault.memories.push({ id: "m-dev", text: "The cache uses Redis.", labels: [] });
    const remember = (await session.tools()).find((t) => t.name === "remember");
    const answer = await remember?.run({ text: "The cache uses Redis." }, context);
    expect(answer).toContain("recorded by another agent (grafeno-agent-dev)");
  });
});

describe("rooms of the same name in several palaces", () => {
  it("names the session's palace when the model leaves it out and the room is ambiguous", async () => {
    const vault = new FakeVault({
      palace_anchor: (args) =>
        args.palace === undefined
          ? {
              text: 'palace_anchor failed: several palaces have a room named "General" (grafeno-agent, demo): say which with palace',
              isError: true,
            }
          : ok({ anchored: true, palace: args.palace }),
    });
    const { session } = await start(vault);
    const anchor = (await session.tools()).find((t) => t.name === "palace_anchor");
    const answer = await anchor?.run({ memory: "m1", room: "General" }, context);
    expect(answer).toContain('"palace":"demo"');
    expect(vault.called("palace_anchor").at(-1)).toMatchObject({ room: "General", palace: "demo" });
  });

  it("leaves a palace the model named alone", async () => {
    const vault = new FakeVault({
      palace_anchor: () => ({ text: 'several palaces have a room named "General"', isError: true }),
    });
    const { session } = await start(vault);
    const anchor = (await session.tools()).find((t) => t.name === "palace_anchor");
    await expect(
      anchor?.run({ memory: "m1", room: "General", palace: "other" }, context),
    ).rejects.toThrow(/several palaces/);
  });
});
