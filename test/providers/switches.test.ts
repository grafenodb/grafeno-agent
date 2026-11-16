import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeProviders, providersCommand } from "../../src/app/providers-command.js";
import { ClaudeCodeModel } from "../../src/model/claude-code.js";
import { CodexModel } from "../../src/model/codex.js";
import { childEnv } from "../../src/model/env.js";
import { collectTurn, FakeModel } from "../../src/model/index.js";
import { CodexProvider, type AskAppServer, type RunCodex } from "../../src/providers/codex.js";
import { ComposedProvider } from "../../src/providers/compose.js";
import {
  autoMembers,
  chosenProviders,
  providerForKinds,
  providerIds,
} from "../../src/providers/index.js";
import {
  canonicalProvider,
  providerEnabled,
  switchVariables,
  withSwitch,
} from "../../src/providers/profiles.js";
import type { ProviderStatus } from "../../src/providers/types.js";
import { TASK_KINDS } from "../../src/orchestrator/plan.js";
import { RecordingToolHost } from "../model/tool-host.js";

const OFF = { PROVIDER_CLAUDE_CODE_LOCAL_ENABLED: "false" };

/** A provider that counts what is asked of it. */
function counted(id: string) {
  const asked = { status: 0, create: 0 };
  const provider = new ComposedProvider(id, `Fake ${id}`, {
    auth: {
      method: "provider-cli",
      signIn: "",
      status: () => {
        asked.status++;
        return Promise.resolve({ installed: true, signedIn: true, detail: "ready" });
      },
      usage: () => Promise.resolve({ limits: [{ label: "Session", used: 0.1 }], at: new Date() }),
    },
    catalog: {
      tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
      models: () => Promise.resolve([]),
      efforts: () => [],
      modelName: (m) => m,
    },
    runtime: {
      features: {
        agentTools: true,
        streaming: true,
        keepsConversation: true,
        usageReport: true,
        nonInteractive: true,
      },
      create: () => {
        asked.create++;
        return new FakeModel({ turns: [[{ say: "hi" }]] });
      },
    },
  });
  return { provider, asked };
}

describe("switching a provider off", () => {
  it("reads PROVIDER_<NAME>_ENABLED for the provider and its aliases, each call", () => {
    expect(switchVariables("claude-code")).toEqual([
      "PROVIDER_CLAUDE_CODE_LOCAL_ENABLED",
      "PROVIDER_CLAUDE_CODE_ENABLED",
    ]);
    expect(providerEnabled("claude-code", {})).toBe(true);
    for (const value of ["false", "0", "off", "NO"]) {
      expect(providerEnabled("claude-code", { PROVIDER_CLAUDE_CODE_LOCAL_ENABLED: value })).toBe(
        false,
      );
    }
    expect(providerEnabled("claude-code", { PROVIDER_CLAUDE_CODE_ENABLED: "false" })).toBe(false);
    // One provider's switch never touches another's.
    expect(providerEnabled("claude-api", OFF)).toBe(true);
    expect(providerEnabled("codex", OFF)).toBe(true);
  });

  it("stops it at once: no status asked, no model started, and back on when switched on", async () => {
    let env: Record<string, string | undefined> = { ...OFF };
    const { provider, asked } = counted("claude-code");
    const switched = withSwitch(provider, () => env);
    const off = await switched.status();
    expect(off).toMatchObject({ installed: false, signedIn: false });
    expect(off.detail).toContain("PROVIDER_CLAUDE_CODE_LOCAL_ENABLED=false");
    expect(await switched.usage()).toBeUndefined();
    await expect(
      switched.create({}).open({ system: "", tools: new RecordingToolHost() }),
    ).rejects.toMatchObject({
      kind: "setup",
    });
    expect(asked).toEqual({ status: 0, create: 0 });
    env = {};
    expect((await switched.status()).signedIn).toBe(true);
    const conversation = await switched
      .create({})
      .open({ system: "", tools: new RecordingToolHost() });
    expect((await collectTurn(conversation.send("x"))).result.text).toBe("hi");
    expect(asked).toEqual({ status: 1, create: 1 });
  });

  it("leaves it out of the choice, while the others go on", () => {
    expect(
      chosenProviders({ AGENT_PROVIDERS: "claude-code-local,codex", ...OFF }).map((p) => p.id),
    ).toEqual(["codex"]);
    expect(
      chosenProviders({ AGENT_PROVIDERS: "claude-code-local,codex" }).map((p) => p.id),
    ).toEqual(["claude-code", "codex"]);
  });
});

describe("claude-code-local, an alias of claude-code", () => {
  it("is understood wherever a provider is named", () => {
    expect(canonicalProvider("claude-code-local")).toBe("claude-code");
    expect(canonicalProvider("codex")).toBe("codex");
    expect(providerIds("claude-code-local,codex", {})).toEqual(["claude-code", "codex"]);
    expect(autoMembers({ AGENT_AUTO_PROVIDERS: "claude-code-local" })).toEqual(["claude-code"]);
    expect(providerForKinds("docs=claude-code-local", TASK_KINDS)).toEqual({ docs: "claude-code" });
  });
});

describe("grafeno-agent providers", () => {
  it("switches one off and on, by its name or alias, and only that one", async () => {
    const saved: Record<string, string>[] = [];
    const said: string[] = [];
    const options = {
      say: (l: string) => said.push(l),
      saveSettings: (v: Record<string, string>) => saved.push(v),
    };
    expect(await providersCommand(["disable", "claude-code-local"], options)).toBe(0);
    expect(saved[0]).toEqual({
      PROVIDER_CLAUDE_CODE_LOCAL_ENABLED: "false",
      PROVIDER_CLAUDE_CODE_ENABLED: "false",
    });
    expect(said.join("\n")).toContain("switched off");
    expect(await providersCommand(["enable", "claude-code"], options)).toBe(0);
    expect(saved[1]).toEqual({
      PROVIDER_CLAUDE_CODE_LOCAL_ENABLED: "true",
      PROVIDER_CLAUDE_CODE_ENABLED: "true",
    });
    expect(await providersCommand(["disable", "nobody"], options)).toBe(2);
    expect(await providersCommand(["install", "codex"], options)).toBe(2);
    let installed = 0;
    expect(
      await providersCommand(["install", "claude-api"], {
        ...options,
        install: () => {
          installed++;
          return Promise.resolve(0);
        },
      }),
    ).toBe(0);
    expect(installed).toBe(1);
  });

  it("shows how each signs in, whether it is on, its standing and what bills", () => {
    const status = (s: Partial<ProviderStatus>): ProviderStatus => ({
      installed: true,
      signedIn: true,
      detail: "ok",
      ...s,
    });
    const lines = describeProviders(
      [
        { provider: counted("claude-code").provider, status: status({}) },
        {
          provider: counted("claude-api").provider,
          status: status({ billing: { kind: "metered", detail: "API" } }),
        },
      ],
      { ...OFF, AGENT_AUTO_PROVIDERS: "claude-api" },
    ).join("\n");
    expect(lines).toMatch(/claude-code-local\s+Fake claude-code\s+official-cli\s+off\s+not ready/);
    expect(lines).toMatch(/Compliance: pending review by Anthropic/);
    expect(lines).toMatch(/not approved or certified by Anthropic/);
    expect(lines).toMatch(/claude-api\s+Fake claude-api\s+api-key\s+on\s+ready · in Auto/);
    expect(lines).toMatch(/Billed per token: not allowed, so never used/);
  });
});

describe("isolation between providers", () => {
  it("starts an official program without any key that would switch it to the API", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant",
        Anthropic_Auth_Token: "tok",
        CODEX_API_KEY: "c",
        OPENAI_API_KEY: "o",
        GRAFENO_AGENT_KEY: "g",
      },
      { EXTRA: "1" },
    );
    expect(env).toEqual({ PATH: "/bin", EXTRA: "1" });
  });

  it("runs claude-code-local's Claude Code without ANTHROPIC_API_KEY, so it uses its own sign-in", async () => {
    const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
    const seen: Record<string, string | undefined>[] = [];
    const capture = ((
      _command: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
    ) => {
      seen.push({ ...options.env });
      return spawn(process.execPath, [FAKE_CLAUDE, ...args], options);
    }) as unknown as typeof spawn;
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach-claude-code";
    try {
      const conversation = await new ClaudeCodeModel({ spawn: capture }).open({
        system: "",
        tools: new RecordingToolHost(),
      });
      await conversation.close();
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      else process.env.ANTHROPIC_API_KEY = before;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen[0]?.PATH ?? seen[0]?.Path).toBeTruthy();
  });

  it("runs Codex without CODEX_API_KEY or OPENAI_API_KEY, so it uses ChatGPT's sign-in", async () => {
    const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
    const seen: Record<string, string | undefined>[] = [];
    const capture = ((
      command: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
    ) => {
      seen.push({ ...options.env });
      return spawn(command, args, options);
    }) as unknown as typeof spawn;
    const before = { codex: process.env.CODEX_API_KEY, openai: process.env.OPENAI_API_KEY };
    process.env.CODEX_API_KEY = "codex-key";
    process.env.OPENAI_API_KEY = "openai-key";
    try {
      const model = new CodexModel({
        command: process.execPath,
        commandPrefix: [FAKE_CODEX],
        spawn: capture,
      });
      const conversation = await model.open({ system: "", tools: new RecordingToolHost() });
      await collectTurn(conversation.send("hello")).catch(() => undefined);
      await conversation.close();
    } finally {
      for (const [name, value] of [
        ["CODEX_API_KEY", before.codex],
        ["OPENAI_API_KEY", before.openai],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toHaveProperty("CODEX_API_KEY");
    expect(seen[0]).not.toHaveProperty("OPENAI_API_KEY");
    expect(seen[0]?.GRAFENO_AGENT_MCP_TOKEN).toBeTruthy();
  });

  it("never spends Codex's rate-limit reset credit: only reads the account and its limits", async () => {
    const asked: string[] = [];
    const run: RunCodex = (args) =>
      Promise.resolve(args[0] === "--version" ? "codex-cli 0.169.0" : "Logged in using ChatGPT");
    const ask: AskAppServer = (method) => {
      asked.push(method);
      return Promise.resolve(
        method === "account/read"
          ? { account: { type: "chatgpt", planType: "plus" } }
          : {
              rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
              rateLimitResetCredits: { availableCount: 1 },
            },
      );
    };
    const codex = new CodexProvider(run, ask);
    await codex.status();
    await codex.usage();
    expect([...new Set(asked)].sort()).toEqual(["account/rateLimits/read", "account/read"]);
  });
});
