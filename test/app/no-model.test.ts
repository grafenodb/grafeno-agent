import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatProvider } from "../../src/app/services.js";
import { AgentSession } from "../../src/app/session.js";
import type { Config } from "../../src/config.js";
import { FakeModel, ModelError } from "../../src/model/index.js";
import { providerIds } from "../../src/providers/index.js";
import { isNoModel, NO_MODEL, NoModelProvider } from "../../src/providers/none.js";
import type { Provider } from "../../src/providers/types.js";
import { SessionStore } from "../../src/sessions/store.js";
import { FakeVault } from "../memory/fake-vault.js";

function fake(id: string, name: string, said: string[] = []): Provider {
  return {
    id,
    name,
    signIn: "sign in",
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "Ready." }),
    models: () => Promise.resolve([]),
    efforts: () => [],
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () =>
      new FakeModel({
        turns: [
          [
            {
              say: (c) => {
                said.push(c.message);
                return "answered";
              },
            },
          ],
        ],
      }),
  };
}

describe("which model the chat starts with", () => {
  const claude = fake("claude-code", "Claude");
  const codex = fake("codex", "Codex");
  const providers = [claude, codex];

  it("none chosen: no model, whatever is signed in", () => {
    expect(isNoModel(chatProvider(providers, { AGENT_PROVIDERS: NO_MODEL }))).toBe(true);
    expect(providerIds(NO_MODEL, {})).toEqual([]);
  });

  it("the one chosen, when it is switched on", () => {
    expect(chatProvider(providers, { AGENT_PROVIDERS: "codex,claude-code" }).id).toBe("codex");
  });

  it("the one chosen switched off: no model, said, never the next in the list", async () => {
    const chosen = chatProvider(providers, {
      AGENT_PROVIDERS: "codex,claude-code",
      PROVIDER_CODEX_ENABLED: "false",
    });
    expect(isNoModel(chosen)).toBe(true);
    expect((await chosen.status()).detail).toContain("Codex is switched off");
  });

  it("Auto: the first switched on; every one off, no model", async () => {
    expect(chatProvider(providers, { PROVIDER_CLAUDE_CODE_ENABLED: "false" }).id).toBe("codex");
    const none = chatProvider(providers, {
      PROVIDER_CLAUDE_CODE_ENABLED: "false",
      PROVIDER_CODEX_ENABLED: "false",
    });
    expect(isNoModel(none)).toBe(true);
    expect((await none.status()).detail).toContain("Every connection is switched off");
  });

  it("no model never reasons: it says how to choose one", async () => {
    const model = new NoModelProvider().create();
    await expect(
      model.open({ system: "", tools: { tools: [], call: () => Promise.reject(new Error()) } }),
    ).rejects.toThrow(/No model is selected/);
    const status = await new NoModelProvider().status();
    expect(status.installed || status.signedIn).toBe(false);
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

describe("a connection switched off is never used", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-off-"));
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "PROVIDER_LOCALTEST_ENABLED");
    rmSync(dir, { recursive: true, force: true });
  });

  it("not even by a conversation already open with it: off takes effect at the next message", async () => {
    const said: string[] = [];
    const session = await AgentSession.start({
      config,
      identity: { name: "grafeno-agent-test", ownOnly: true },
      vault: new FakeVault(),
      store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
      cwd: dir,
      provider: fake("localtest", "Local test", said),
      tools: () => [],
    });
    await session.send("first");
    expect(said).toHaveLength(1);
    process.env.PROVIDER_LOCALTEST_ENABLED = "false";
    const refused = session.send("second");
    await expect(refused).rejects.toBeInstanceOf(ModelError);
    await expect(session.send("third")).rejects.toThrow(/Local test is switched off/);
    expect(said).toHaveLength(1);
    await session.close();
  });
});
