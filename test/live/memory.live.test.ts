import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import { loadConfig } from "../../src/config.js";
import { MemorySession } from "../../src/memory/session.js";
import { answerId, grafenoVault, type Vault } from "../../src/memory/vault.js";
import { FakeModel } from "../../src/model/index.js";

// Two sessions against the real Grafeno server in the settings, with the
// fake model (no plan usage): the second picks up what the first left,
// without being told. Everything it writes is deleted afterwards.
if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const real = grafenoVault(config);
const written = new Set<string>();

/** The real vault, noting every node it writes so the test can delete them. */
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

const project = { name: `test-${randomUUID().slice(0, 8)}` };

afterAll(async () => {
  for (const id of written) await real.call("forget", { id, mode: "delete" });
});

describe("memory across sessions (real Grafeno, fake model)", () => {
  it("brings back a preference and the checkpoint in a new session", async () => {
    const first = await MemorySession.start({ vault, project, knownSecrets: [config.agentKey] });
    const agent1 = new Agent({
      model: new FakeModel({
        turns: [
          [
            {
              call: "remember",
              input: {
                text: "The user prefers tabs over spaces for indentation.",
                name: "Indentation preference",
                labels: ["Preference"],
                origin: "stated",
              },
            },
            { say: "Noted." },
          ],
          [
            {
              call: "checkpoint",
              input: {
                summary: "Configured the linter; the formatter still uses spaces.",
                next: ["Switch the formatter to tabs"],
              },
            },
            { say: "Saved." },
          ],
        ],
      }),
      system: first.systemPrompt("BASE"),
      tools: new ToolRegistry(await first.tools()),
      prepare: (m) => first.beforeTurn(m),
    });
    await agent1.turn("I prefer tabs over spaces.");
    await agent1.turn(first.endOfSession());
    await agent1.close();

    // A secret is refused, and never reaches memory.
    const remember = (await first.tools()).find((t) => t.name === "remember");
    await expect(
      remember?.run(
        { text: `The key is ${config.agentKey}` },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/Not stored/);

    const second = await MemorySession.start({ vault, project, knownSecrets: [config.agentKey] });
    expect(second.projectId).toBe(first.projectId);
    const system = second.systemPrompt("BASE");
    expect(system).toContain("Switch the formatter to tabs");
    expect(system).toContain("tabs over spaces");

    const prepared = await second.beforeTurn("Should the formatter indent with tabs or spaces?");
    expect(prepared).toMatch(/^<memory>[\s\S]*tabs over spaces[\s\S]*<\/memory>/);
  });
});
