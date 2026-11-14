import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import { loadConfig } from "../../src/config.js";
import { normalize } from "../../src/memory/quality.js";
import { MemorySession, ROOM } from "../../src/memory/session.js";
import { upkeep } from "../../src/memory/upkeep.js";
import { answerId, grafenoVault, type Vault } from "../../src/memory/vault.js";
import { FakeModel, type FakeStep, type FakeTurn } from "../../src/model/index.js";

// A long scripted run against the real Grafeno server, with the fake model
// (no plan usage): three sessions that store facts, repeat some, and change
// one. Afterwards memory must hold no duplicates, no contradiction left
// unflagged, and a palace the review finds nothing to fix in. Everything it
// writes is deleted at the end.
if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const real = grafenoVault(config);
const written = new Set<string>();
const vault: Vault = {
  namespace: real.namespace,
  tools: () => real.tools(),
  call: async (name, args) => {
    const answer = await real.call(name, args);
    const id = answerId(answer);
    if (id !== undefined && ["remember", "checkpoint", "palace_create"].includes(name)) {
      written.add(id);
    }
    return answer;
  },
};
const project = { name: `quality-${randomUUID().slice(0, 8)}` };

afterAll(async () => {
  for (const id of written) await real.call("forget", { id, mode: "delete" });
});

const FACTS = [
  ["Fact", "The service exposes its API under the /v2 prefix."],
  ["Decision", "Errors are reported with RFC 9457 problem details."],
  ["Preference", "The user wants commit messages written in English."],
  ["Fact", "Integration tests need Docker running locally."],
  ["Decision", "Feature flags live in LaunchDarkly, never in code."],
  ["Question", "Should the cache move from Redis to Valkey?"],
  ["Fact", "Builds publish container images to GHCR."],
  ["Preference", "Pull requests stay below four hundred changed lines."],
  ["Decision", "Database migrations run with Flyway on deploy."],
  ["Fact", "The on-call rotation changes every Monday morning."],
] as const;

const remember = ([label, text]: readonly [string, string]): FakeStep => ({
  call: "remember",
  input: { text, labels: [label], origin: "stated" },
});

let oldManager = "";
let newManager = "";

async function session(turns: FakeTurn[], messages: string[]): Promise<string[]> {
  const memory = await MemorySession.start({ vault, project, knownSecrets: [config.agentKey] });
  const agent = new Agent({
    model: new FakeModel({ turns }),
    system: memory.systemPrompt("BASE"),
    tools: new ToolRegistry(await memory.tools()),
    prepare: (m) => memory.beforeTurn(m),
  });
  const results: string[] = [];
  for (const message of messages) {
    const turn = await agent.turn(message, {
      onEvent: (event) => {
        if (event.type === "tool_result") results.push(event.outcome.content);
      },
    });
    expect(turn.result.stopReason).toBe("end_turn");
  }
  await agent.close();
  return results;
}

const idIn = (text: string | undefined) => /"id":\s*"([^"]+)"/.exec(text ?? "")?.[1] ?? "";

describe("a long run keeps memory in order (real Grafeno, fake model)", () => {
  it("leaves no duplicates, no unflagged contradiction and nothing to fix", async () => {
    // Session 1: six facts, two of them told twice, and a fact about the package manager.
    const first = await session(
      [
        ...FACTS.slice(0, 6).map((fact) => [remember(fact), { say: "Noted." }]),
        [remember(FACTS[1]), { say: "Noted." }],
        [remember(FACTS[3]), { say: "Noted." }],
        [
          {
            call: "remember",
            input: { text: "The project installs packages with npm.", labels: ["Fact"] },
          },
          {
            say: (c) => {
              oldManager = idIn(c.results[0]?.content);
              return "Noted.";
            },
          },
        ],
      ],
      [...FACTS.slice(0, 6).map((_, i) => `fact ${String(i)}`), "again 1", "again 3", "npm"],
    );
    expect(first.filter((r) => r.startsWith("Already in memory"))).toHaveLength(2);

    // Session 2: the package manager changed; four new facts; one old fact told again; a secret.
    const second = await session(
      [
        [
          {
            call: "remember",
            input: { text: "The project switched to pnpm to install packages.", labels: ["Fact"] },
          },
          {
            call: "relate",
            input: (c) => {
              newManager = idIn(c.results[0]?.content);
              return {
                from: newManager,
                label: "supersedes",
                to: oldManager,
                reason: "The user said the project moved from npm to pnpm.",
              };
            },
          },
          {
            call: "feedback",
            input: () => ({ id: oldManager, verdict: "obsolete", note: "replaced by pnpm" }),
          },
          { say: "Updated." },
        ],
        ...FACTS.slice(6).map((fact) => [remember(fact), { say: "Noted." }]),
        [remember(FACTS[0]), { say: "Noted." }],
        [
          { call: "remember", input: { text: `The deploy token is ${config.agentKey}` } },
          { say: "Not stored." },
        ],
        [
          { call: "checkpoint", input: { summary: "Recorded the service's conventions." } },
          { say: "Saved." },
        ],
      ],
      ["pnpm now", "f6", "f7", "f8", "f9", "again 0", "secret", "bye"],
    );
    expect(second.filter((r) => r.startsWith("Already in memory"))).toHaveLength(1);
    expect(second.some((r) => r.includes("Not stored"))).toBe(true);

    // Session 3: a fact told again, in other words of the same kind.
    const third = await session(
      [[remember(["Fact", "the service exposes its API under the /V2 prefix"]), { say: "Noted." }]],
      ["v2"],
    );
    expect(third[0]).toMatch(/^Already in memory/);

    // No duplicates in the room.
    const map = (
      await vault.call("palace_map", {
        palace: project.name,
        room: ROOM,
        memories: true,
        limit: 200,
      })
    ).data as { room?: { loci?: { memories?: { id: string }[] }[] } };
    const ids = (map.room?.loci ?? []).flatMap((locus) => (locus.memories ?? []).map((m) => m.id));
    const memories = new Set(ids);
    const texts: string[] = [];
    for (const id of memories) {
      const node = await real.call("get_node", { id });
      const data = (node.data ?? JSON.parse(node.text)) as {
        text?: string;
        node?: { text?: string };
      };
      texts.push(normalize(data.text ?? data.node?.text ?? ""));
    }
    expect(texts.every((text) => text !== "")).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
    // The ten facts, the two package-manager memories and the project itself.
    expect(memories.size).toBe(13);

    // Grafeno's own checks find nothing to fix.
    const report = await upkeep({ vault, palace: project.name, projectId: "" });
    expect(report.items).toEqual([]);
  });
});
