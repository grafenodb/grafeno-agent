import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE, shouldRenew } from "../../src/app/lifecycle.js";
import { AgentSession } from "../../src/app/session.js";
import type { Config } from "../../src/config.js";
import { packCheckpoint } from "../../src/memory/checkpoint.js";
import { FakeModel } from "../../src/model/index.js";
import { SessionStore } from "../../src/sessions/store.js";
import { FakeVault } from "../memory/fake-vault.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 8, minutes));

describe("shouldRenew", () => {
  const base = { now: at(0), turnsSinceRenewal: 5 };

  it("keeps a conversation the provider said nothing about, or that just started", () => {
    expect(shouldRenew(base).renew).toBe(false);
    expect(
      shouldRenew({
        ...base,
        turnsSinceRenewal: 1,
        context: { used: 190_000, window: 200_000 },
      }).renew,
    ).toBe(false);
  });

  it("renews a nearly full context", () => {
    const decision = shouldRenew({ ...base, context: { used: 170_000, window: 200_000 } });
    expect(decision).toEqual({ renew: true, reason: "the context was 85% full (170k tokens)" });
  });

  it("renews a large context after a pause long enough for the cache to go cold", () => {
    const decision = shouldRenew({
      ...base,
      now: at(75),
      lastActivity: at(0),
      context: { used: 120_000, window: 1_000_000 },
    });
    expect(decision.renew).toBe(true);
    expect(decision.renew && decision.reason).toMatch(/75 minutes without a message.*120k tokens/);
  });

  it("keeps a small context after a pause, and a large one while the cache is warm", () => {
    expect(
      shouldRenew({ ...base, now: at(90), lastActivity: at(0), context: { used: 20_000 } }).renew,
    ).toBe(false);
    expect(
      shouldRenew({ ...base, now: at(10), lastActivity: at(0), context: { used: 400_000 } }).renew,
    ).toBe(false);
    expect(DEFAULT_LIFECYCLE.idleMinutes).toBe(60);
  });
});

const config: Config = {
  grafenoMode: "external",
  grafenoUrl: "http://grafeno.test:7810",
  agentKey: "gk_test_0123456789abcdef",
  namespace: "test",
  model: "fake",
  embedder: "none",
  palace: "shared",
};

describe("renewing a conversation in a session", () => {
  async function session(clock: { now: Date }, model: FakeModel, vault: FakeVault) {
    const dir = mkdtempSync(join(tmpdir(), "grafeno-agent-lifecycle-"));
    return AgentSession.start({
      config,
      vault,
      store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
      cwd: dir,
      makeModel: () => model,
      tools: () => [],
      now: () => clock.now,
    });
  }

  it("after a long pause with a large context: a checkpoint, a new conversation from the compact resume, the end of the old one", async () => {
    let latest = {
      ...packCheckpoint({
        task: "demo: work",
        goal: "Ship the parser",
        summary: "Lexer done.",
        next_action: "Write the grammar",
        decisions: ["Hand-written parser"],
        memory_refs: [],
      }),
      id: "cp1",
    } as Record<string, unknown>;
    const vault = new FakeVault({
      resume: () => ({ text: "{}", isError: false, data: { found: true, checkpoint: latest } }),
      checkpoint: (args) => {
        latest = { ...args, id: "cp2" };
        return { text: '{"id":"cp2"}', isError: false, data: { id: "cp2" } };
      },
    });
    const model = new FakeModel({
      turns: [
        [
          {
            call: "remember",
            input: { text: "The grammar uses Pratt parsing.", labels: ["Decision"] },
          },
          { context: 150_000, window: 1_000_000 },
          { say: "Noted." },
        ],
        [{ context: 151_000, window: 1_000_000 }, { say: "Second." }],
        [{ say: (c) => `fresh: ${c.message.slice(0, 40)}` }],
      ],
    });
    const clock = { now: at(0) };
    const agent = await session(clock, model, vault);
    await agent.send("Use Pratt parsing for the grammar.");
    await agent.send("Anything else?");
    const notices: string[] = [];
    clock.now = at(90); // The plan's window ran out; the user comes back.
    await agent.send("Go on.", { onRenewal: (n) => notices.push(n) });

    expect(agent.renewals).toBe(1);
    expect(notices[0]).toMatch(/^Started a fresh conversation: 90 minutes without a message/);
    expect(notices[0]).toContain("a checkpoint saved just now");
    // The checkpoint carried the state forward, with the memory stored since.
    const saved = vault.called("checkpoint").at(-1) ?? {};
    expect(saved).toMatchObject({ task: "demo: work", next: ["Write the grammar"] });
    expect(String(saved.summary)).toMatch(/Lexer done\.\nConversation renewed: 90 minutes/);
    expect(String(saved.summary)).toMatch(/"goal":"Ship the parser"/);
    expect(String(saved.summary)).toMatch(/"memory_refs":\["m\d+"\]/);
    // A new conversation, from the compact resume built again, with the end of the old one.
    expect(model.conversations).toHaveLength(2);
    expect(model.conversations[1]?.system).toContain("Conversation renewed");
    expect(model.conversations[1]?.messages[0]).toMatch(
      /<previous_conversation>[\s\S]*Anything else\?/,
    );
    expect(agent.conversation.entries.some((e) => e.kind === "notice")).toBe(true);
  });

  it("does not renew while the cache is warm, nor when told never to", async () => {
    const vault = new FakeVault();
    const turns = [
      [{ context: 600_000, window: 1_000_000 }, { say: "a" }],
      [{ context: 600_000, window: 1_000_000 }, { say: "b" }],
      [{ say: "c" }],
    ];
    const clock = { now: at(0) };
    const warm = await session(clock, new FakeModel({ turns }), vault);
    await warm.send("1");
    await warm.send("2");
    clock.now = at(5);
    await warm.send("3");
    expect(warm.renewals).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), "grafeno-agent-lifecycle-"));
    const never = await AgentSession.start({
      config,
      vault: new FakeVault(),
      store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
      cwd: dir,
      makeModel: () => new FakeModel({ turns }),
      tools: () => [],
      now: () => clock.now,
      lifecycle: false,
    });
    await never.send("1");
    await never.send("2");
    clock.now = at(200);
    await never.send("3");
    expect(never.renewals).toBe(0);
  });
});
