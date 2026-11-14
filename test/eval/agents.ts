/**
 * Several agents on one task, at the same time (phase 9's "done when"):
 *
 *   npm run eval:agents
 *
 * Two agents, each with a key of its own (`--own-only`), work on one
 * project in a shared palace while a third keeps a palace of its own. They
 * run on the fake model against a Grafeno of their own, in memory, with
 * owner token, so nothing here spends plan usage. It checks that every
 * write lands under the name of the agent that made it, that neither can
 * change or bury what the other recorded (only supersede it, visibly), that
 * each agent's checkpoint stays its own and the other's reaches it, and
 * that an agent's own palace stays apart. It fails on the first broken
 * promise, and says which.
 */
import { randomUUID } from "node:crypto";
import { Grafeno } from "@grafenodb/client";
import { Agent } from "../../src/agent/agent.js";
import { SYSTEM_PROMPT } from "../../src/agent/builtin-tools.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import type { Config } from "../../src/config.js";
import { MemorySession, ROOM, type AgentName } from "../../src/memory/session.js";
import { answerId, grafenoVault, type Vault, type VaultAnswer } from "../../src/memory/vault.js";
import { FakeModel, type FakeStep, type ToolOutcome } from "../../src/model/index.js";
import { startGrafeno } from "./grafeno-server.js";

const OWNER = `owner-${randomUUID()}`;
const NAMESPACE = "agents";
const PROJECT = { name: "pair-parser" };
/** What each agent stores something about in the first round, all at once. */
const TOPICS = [
  "comments",
  "strings",
  "numbers",
  "identifiers",
  "operators",
  "keywords",
  "whitespace",
  "unicode escapes",
  "nested blocks",
  "error recovery",
  "source positions",
  "trailing commas",
];
const EACH = TOPICS.length;

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function dataOf(answer: VaultAnswer): Record<string, unknown> {
  return (answer.data ?? JSON.parse(answer.text)) as Record<string, unknown>;
}

interface Member {
  readonly identity: AgentName;
  readonly vault: Vault;
  readonly key: string;
}

/** One session of one agent: a conversation of scripted turns; what the tools answered. */
async function session(
  member: Member,
  turns: readonly (readonly FakeStep[])[],
  palace: "shared" | "own" = "shared",
): Promise<{ memory: MemorySession; outcomes: ToolOutcome[] }> {
  const memory = await MemorySession.start({
    vault: member.vault,
    project: PROJECT,
    agent: member.identity,
    palace,
    knownSecrets: [member.key],
  });
  const outcomes: ToolOutcome[] = [];
  const agent = new Agent({
    model: new FakeModel({ turns: [...turns, [{ say: "Saved." }]] }),
    system: memory.systemPrompt(SYSTEM_PROMPT),
    tools: new ToolRegistry(await memory.tools(), () => false, { redact: [member.key] }),
    prepare: (message) => memory.beforeTurn(message),
  });
  try {
    for (const [index] of turns.entries()) {
      await agent.turn(`step ${String(index + 1)}`, {
        onEvent: (event) => {
          if (event.type === "tool_result") outcomes.push(event.outcome);
        },
      });
    }
  } finally {
    await agent.close();
  }
  return { memory, outcomes };
}

const remember = (text: string, labels = ["Fact"]): FakeStep => ({
  call: "remember",
  input: { text, labels, origin: "observed" },
});

async function main(): Promise<void> {
  const grafeno = await startGrafeno({ ownerToken: OWNER });
  try {
    const owner = new Grafeno({ url: grafeno.url, token: OWNER });
    async function member(name: string): Promise<Member> {
      const { secret } = await owner.createKey({
        name,
        grants: [{ namespace: NAMESPACE, role: "write" }],
        own_only: true,
      });
      const config: Config = {
        grafenoUrl: grafeno.url,
        agentKey: secret,
        namespace: NAMESPACE,
        model: "fake",
        embedder: "none",
        grafenoMode: "external",
        palace: "shared",
      };
      const me = await new Grafeno({ url: grafeno.url, token: secret }).whoami();
      return {
        identity: { name: me.via?.name ?? me.name, ownOnly: me.own_only },
        vault: grafenoVault(config),
        key: secret,
      };
    }
    const dev = await member("grafeno-agent-dev");
    const review = await member("grafeno-agent-review");
    const solo = await member("grafeno-agent-solo");
    const ownerVault = grafenoVault({
      grafenoUrl: grafeno.url,
      agentKey: OWNER,
      namespace: NAMESPACE,
      model: "fake",
      embedder: "none",
      grafenoMode: "external",
      palace: "shared",
    });

    console.log("Round 1: both agents start on the project at the same moment, and store at once");
    // Distinct enough by their words that the duplicate guard keeps them all.
    const devFacts = TOPICS.map((topic) => `Dev wrote the ${topic} part of the parser`);
    const reviewFacts = TOPICS.map((topic) => `Review asks for tests on ${topic} handling`);
    const decision = "The parser uses a hand-written recursive descent design";
    const [devOne, reviewOne] = await Promise.all([
      session(dev, [[remember(decision, ["Decision"]), ...devFacts.map((t) => remember(t))]]),
      session(review, [reviewFacts.map((t) => remember(t))]),
    ]);
    check(
      devOne.memory.projectId === reviewOne.memory.projectId,
      "both agents use one project node, though they started at the same moment",
    );
    const projects = dataOf(
      await ownerVault.call("recall", {
        query: PROJECT.name,
        labels: ["Project"],
        limit: 10,
        depth: 0,
      }),
    ).results as { name?: string }[];
    check(
      projects.filter((p) => p.name === PROJECT.name).length === 1,
      "there is exactly one node for the project",
    );
    check(
      [...devOne.outcomes, ...reviewOne.outcomes].every((o) => o.isError !== true),
      "every write of round 1 was accepted",
    );

    // Who recorded what, as Grafeno says.
    const recordedBy = async (text: string): Promise<{ id?: string; by?: string | undefined }> => {
      const found = dataOf(await ownerVault.call("recall", { query: text, limit: 3, depth: 0 }))
        .results as { id: string; text: string }[];
      const hit = found.find((r) => r.text === text || r.text.endsWith(`: ${text}`));
      if (!hit) return {};
      const node = dataOf(await ownerVault.call("get_node", { id: hit.id }));
      return {
        id: hit.id,
        by: (node.provenance as { recorded_by?: string } | undefined)?.recorded_by,
      };
    };
    let devRight = 0;
    for (const text of [decision, ...devFacts]) {
      if ((await recordedBy(text)).by === dev.identity.name) devRight++;
    }
    let reviewRight = 0;
    for (const text of reviewFacts) {
      if ((await recordedBy(text)).by === review.identity.name) reviewRight++;
    }
    check(
      devRight === EACH + 1 && reviewRight === EACH,
      `all ${String(2 * EACH + 1)} memories landed, each under its agent's name (dev ${String(devRight)}/${String(EACH + 1)}, review ${String(reviewRight)}/${String(EACH)})`,
    );

    const decisionId = (await recordedBy(decision)).id ?? "";
    const devFactId = (await recordedBy(devFacts[0] ?? "")).id ?? "";
    const before = dataOf(await ownerVault.call("get_node", { id: decisionId }));

    console.log("Round 2: at the same time, review tries to undo dev's memory; dev repeats review");
    const correction = "The parser now uses a Pratt design for expressions";
    const [devTwo, reviewTwo] = await Promise.all([
      session(dev, [
        [
          // What review already stored: refused as a duplicate, saying whose it is.
          remember(reviewFacts[0] ?? ""),
          // Its own: it may change it.
          {
            call: "update",
            input: { id: devFactId, props: { checked: true } },
          },
          {
            call: "checkpoint",
            input: {
              summary: "DEV-SUMMARY: the recursive descent parser is written.",
              next: ["error recovery"],
            },
          },
        ],
      ]),
      session(review, [
        [
          { call: "update", input: { id: decisionId, text: "The parser uses a generator" } },
          { call: "feedback", input: { id: decisionId, verdict: "obsolete" } },
          { call: "forget", input: { id: decisionId } },
          remember(correction, ["Decision"]),
          {
            call: "relate",
            input: (context) => ({
              from: answerId({ text: context.results.at(-1)?.content ?? "", isError: false }),
              label: "supersedes",
              to: decisionId,
              reason: "review found expressions need precedence climbing",
            }),
          },
        ],
      ]),
    ]);
    const [update, feedback, forget, stored, related] = reviewTwo.outcomes;
    check(
      update?.isError === true && /Another agent recorded it/.test(update.content),
      "review may not change dev's decision, and is told how to correct it",
    );
    check(feedback?.isError === true, "review may not mark dev's decision obsolete");
    check(forget?.isError === true, "review may not forget dev's decision");
    check(stored?.isError !== true && related?.isError !== true, "review supersedes it instead");
    const after = dataOf(await ownerVault.call("get_node", { id: decisionId }));
    check(
      after.text === before.text && JSON.stringify(after.props) === JSON.stringify(before.props),
      "dev's decision is exactly as dev left it",
    );
    const superseding = (after.facts as { label?: string; recorded_by?: string }[]).filter(
      (f) => f.label === "supersedes",
    );
    check(
      superseding.length === 1 && superseding[0]?.recorded_by === review.identity.name,
      "the correction shows on dev's decision, recorded by review",
    );
    const [duplicate, ownUpdate] = devTwo.outcomes;
    check(
      duplicate?.content.includes(`recorded by another agent (${review.identity.name})`) === true,
      "dev's repeat of review's memory is refused, naming review",
    );
    check(ownUpdate?.isError !== true, "dev may change its own memory");

    console.log("Round 3: review saves its checkpoint; each agent comes back to its own work");
    await session(review, [
      [
        {
          call: "checkpoint",
          input: { summary: "REVIEW-SUMMARY: expressions need a Pratt parser.", next: ["tests"] },
        },
      ],
    ]);
    const devBack = await MemorySession.start({
      vault: dev.vault,
      project: PROJECT,
      agent: dev.identity,
    });
    check(
      /Your latest checkpoint[\s\S]*DEV-SUMMARY/.test(devBack.brief),
      "dev comes back to its own checkpoint",
    );
    check(
      /saved by another agent \(grafeno-agent-review\)[\s\S]*REVIEW-SUMMARY/.test(devBack.brief),
      "and is told of review's newer one, as review's",
    );
    const reviewBack = await MemorySession.start({
      vault: review.vault,
      project: PROJECT,
      agent: review.identity,
    });
    check(
      /Your latest checkpoint[\s\S]*REVIEW-SUMMARY/.test(reviewBack.brief) &&
        !reviewBack.brief.includes("saved by another agent"),
      "review's own checkpoint is the latest: nothing else to tell it",
    );
    const context = await devBack.beforeTurn("Which design does the parser use for expressions?");
    check(
      context.includes("Pratt") && context.includes("supersedes"),
      "what review stored reaches dev, with the correction",
    );

    console.log("Round 4: a third agent keeps a palace of its own");
    const soloRun = await session(solo, [[remember("Solo found the lexer is fast enough")]], "own");
    check(soloRun.memory.projectId === devOne.memory.projectId, "it shares the project node");
    const room = async (palace: string) =>
      JSON.stringify(dataOf(await ownerVault.call("palace_map", { palace, room: ROOM })));
    check(
      (await room(`${PROJECT.name} · ${solo.identity.name}`)).includes("lexer is fast enough") &&
        !(await room(PROJECT.name)).includes("lexer is fast enough"),
      "its memory is in its own palace, not in the shared one",
    );
    const agents = dataOf(
      await ownerVault.call("recall", { query: "agent", labels: ["Agent"], limit: 10, depth: 0 }),
    ).results as { name?: string }[];
    check(
      ["grafeno-agent-dev", "grafeno-agent-review", "grafeno-agent-solo"].every((name) =>
        agents.some((a) => a.name === name),
      ),
      "each agent has a node of its own (what Studio shows them by)",
    );
  } finally {
    await grafeno.stop();
  }

  if (failures.length > 0) {
    console.error(
      `\n${String(failures.length)} failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("\nSeveral agents: all checks passed.");
  }
}

await main();
