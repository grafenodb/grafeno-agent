import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/app/session.js";
import type { Config } from "../../src/config.js";
import { FakeModel } from "../../src/model/index.js";
import type { Provider } from "../../src/providers/types.js";
import { SessionStore } from "../../src/sessions/store.js";
import { FakeVault } from "../memory/fake-vault.js";

const config: Config = {
  grafenoMode: "external",
  grafenoUrl: "http://grafeno.test:7810",
  agentKey: "gk_test_0123456789abcdef",
  namespace: "test",
  model: "fake",
  embedder: "none",
  palace: "shared",
};

describe("freeing the model's context", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-fresh-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the next message in a fresh conversation, carrying the end of this one", async () => {
    const opened: string[][] = [];
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      signIn: "",
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "ok" }),
      models: () => Promise.resolve([]),
      efforts: () => [],
      usage: () => Promise.resolve(undefined),
      modelName: (m) => m,
      // Each model is a new conversation: what it was sent is recorded.
      create: () => {
        const seen: string[] = [];
        opened.push(seen);
        return new FakeModel({
          turns: [
            [
              {
                say: (c) => {
                  seen.push(c.message);
                  return "noted";
                },
              },
            ],
          ],
        });
      },
    };
    const session = await AgentSession.start({
      config,
      identity: { name: "grafeno-agent-test", ownOnly: true },
      vault: new FakeVault(),
      store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
      cwd: dir,
      provider,
      tools: () => [],
    });
    await session.send("The project is called Orion.");
    expect(opened).toHaveLength(1);
    const said = await session.freeContext("asked for (/fresh)");
    expect(said).toContain("Started a fresh conversation: asked for (/fresh)");
    await session.send("What is it called?");
    // A new conversation, given the end of the one before as data.
    expect(opened).toHaveLength(2);
    expect(opened[1]?.[0]).toContain("Orion");
    expect(opened[1]?.[0]).toContain("What is it called?");
    await session.close();
  });
});
