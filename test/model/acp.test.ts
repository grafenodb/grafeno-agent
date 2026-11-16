import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpModel, acpError, permissionAnswer, type AcpLaunch } from "../../src/model/acp.js";
import { collectTurn, ModelError } from "../../src/model/index.js";
import { AcpCliProvider, resolveLaunch } from "../../src/providers/acp-cli.js";
import { RecordingToolHost } from "./tool-host.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));

function host() {
  return new RecordingToolHost({
    echo: {
      spec: {
        description: "Says its text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        writes: false,
      },
      run: (input) => ({ content: `echoed ${String(input.text)}` }),
    },
  });
}

function model(mode = "ok", launch: Partial<AcpLaunch> = {}) {
  return new AcpModel({
    name: "Fake CLI",
    signIn: "Run fake and /login.",
    startTimeoutMs: 20_000,
    launch: () => ({ command: process.execPath, args: [FAKE], ...launch }),
    spawn: ((command: string, args: readonly string[], options: { env?: Record<string, string> }) =>
      spawn(command, args, {
        ...options,
        env: { ...options.env, FAKE_ACP_MODE: mode },
      })) as unknown as typeof spawn,
  });
}

describe("a CLI over ACP", { timeout: 60_000 }, () => {
  it("streams its answer, runs the agent's tools over MCP, and refuses the CLI's own tools", async () => {
    const tools = host();
    const conversation = await model().open({ system: "", tools });
    const { result, events } = await collectTurn(conversation.send("go"));
    expect(tools.calls).toEqual([{ id: "call-1", name: "echo", input: { text: "hi" } }]);
    // The built-in command was refused; the agent's own tool was let through to the agent.
    expect(result.text).toBe("Calling. echoed hi; builtin=no; ours=yes");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["text", "tool_call", "tool_result", "context", "done"]),
    );
    expect(events).toContainEqual({ type: "context", used: 1234, window: 200000 });
    // The same session goes on.
    const again = await collectTurn(conversation.send("go"));
    expect(again.result.stopReason).toBe("end_turn");
    await conversation.close();
  });

  it("runs the CLI in a private folder, with the agent's MCP server and none of its keys", async () => {
    const before = {
      key: process.env.GRAFENO_AGENT_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gh: process.env.GH_TOKEN,
    };
    process.env.GRAFENO_AGENT_KEY = "gk_secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    process.env.GH_TOKEN = "gh-token";
    try {
      const plain = await model().open({ system: "", tools: host() });
      const seen = JSON.parse((await collectTurn(plain.send("env"))).result.text) as Record<
        string,
        unknown
      >;
      await plain.close();
      expect(seen).toMatchObject({
        agentKey: null,
        anthropic: null,
        gh: null,
        server: "grafeno",
        headers: ["Authorization"],
      });
      expect(String(seen.cwd)).toContain("grafeno-agent-acp-");
      // A CLI whose documented sign-in uses GH_TOKEN (Copilot) keeps it, and only it.
      const copilot = await model("ok", { keep: ["GH_TOKEN"] }).open({ system: "", tools: host() });
      const kept = JSON.parse((await collectTurn(copilot.send("env"))).result.text) as Record<
        string,
        unknown
      >;
      await copilot.close();
      expect(kept).toMatchObject({ gh: "gh-token", agentKey: null, anthropic: null });
    } finally {
      for (const [name, value] of [
        ["GRAFENO_AGENT_KEY", before.key],
        ["ANTHROPIC_API_KEY", before.anthropic],
        ["GH_TOKEN", before.gh],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  it("cancels a turn at once, and the session stays usable", async () => {
    const conversation = await model().open({ system: "", tools: host() });
    const abort = new AbortController();
    const started = Date.now();
    const turn = collectTurn(conversation.send("wait", { signal: abort.signal }));
    setTimeout(() => {
      abort.abort();
    }, 200);
    const error = await turn.catch((e: unknown) => e);
    expect((error as ModelError).kind).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    const next = await collectTurn(conversation.send("go"));
    expect(next.result.text).toContain("echoed hi");
    await conversation.close();
  });

  it("says when the CLI is not signed in, or cannot take the agent's tools", async () => {
    const auth = await model("auth")
      .open({ system: "", tools: host() })
      .catch((e: unknown) => e);
    expect((auth as ModelError).kind).toBe("setup");
    expect((auth as ModelError).message).toContain("not signed in");
    const nohttp = await model("nohttp")
      .open({ system: "", tools: host() })
      .catch((e: unknown) => e);
    expect((nohttp as ModelError).message).toContain("does not take an HTTP MCP server");
    const missing = await new AcpModel({
      name: "Ghost",
      signIn: "Install ghost.",
      launch: () => ({ command: join(tmpdir(), "no-such-cli-here"), args: [] }),
    })
      .open({ system: "", tools: host() })
      .catch((e: unknown) => e);
    expect((missing as ModelError).kind).toBe("setup");
  });
});

describe("permissions over ACP", () => {
  const options = [
    { optionId: "a", kind: "allow_once" },
    { optionId: "r", kind: "reject_once" },
  ];
  it("lets the agent's own tools through, and refuses the CLI's built-ins", () => {
    expect(
      permissionAnswer({ toolCall: { title: "grafeno - read_file (MCP)" }, options }, [
        "read_file",
      ]),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "a" },
    });
    expect(
      permissionAnswer({ toolCall: { title: "Edit src/a.ts", kind: "edit" }, options }, [
        "read_file",
      ]),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "r" },
    });
    // A tool of the same name, but not the agent's server: refused.
    expect(
      permissionAnswer({ toolCall: { title: "read_file" }, options }, ["read_file"]).outcome,
    ).toEqual({
      outcome: "selected",
      optionId: "r",
    });
    // Nothing to reject with: cancelled, never allowed.
    expect(
      permissionAnswer(
        { toolCall: { title: "bash" }, options: [{ optionId: "a", kind: "allow_once" }] },
        [],
      ),
    ).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("turns ACP failures into the agent's kinds", () => {
    expect(
      acpError({ code: -32000, message: "Authentication required" }, { name: "X", signIn: "s" })
        .kind,
    ).toBe("setup");
    expect(
      acpError(new Error("quota exceeded for the month"), { name: "X", signIn: "s" }).kind,
    ).toBe("usage_limit");
    expect(acpError(new Error("boom"), { name: "X", signIn: "s" }).kind).toBe("failed");
  });
});

describe("a CLI connection's state", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-acp-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: "copilot",
    acpArgs: ["--acp", "--stdio"],
    install: "npm i -g @github/copilot",
    signIn: "copilot /login",
    plan: "Your GitHub Copilot plan",
  };

  it("is installed only when its --version answers, and signed in only when a session opens", async () => {
    const missing = new AcpCliProvider(spec, { run: () => Promise.reject(new Error("ENOENT")) });
    expect(await missing.status()).toMatchObject({ installed: false, signedIn: false });
    const notSignedIn = new AcpCliProvider(spec, {
      run: () => Promise.resolve("1.0.42\n"),
      probe: () =>
        Promise.reject(
          new ModelError("setup", "GitHub Copilot CLI is not signed in. copilot /login"),
        ),
    });
    expect(await notSignedIn.status()).toMatchObject({
      installed: true,
      signedIn: false,
      version: "1.0.42",
    });
    const ready = new AcpCliProvider(spec, {
      run: () => Promise.resolve("1.0.42"),
      probe: () => Promise.resolve(),
    });
    expect(await ready.status()).toMatchObject({
      installed: true,
      signedIn: true,
      billing: { kind: "subscription" },
    });
  });

  it("finds a Windows .cmd shim and starts it through the shell, with fixed arguments only", () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "kimi.cmd"), "@echo off\n");
    const launch = resolveLaunch("kimi", ["acp"], { PATH: join(dir, "bin") }, "win32");
    expect(launch).toEqual({ command: join(dir, "bin", "kimi.cmd"), args: ["acp"], shell: true });
    expect(resolveLaunch("kimi", ["acp"], { PATH: "/usr/bin" }, "linux")).toEqual({
      command: "kimi",
      args: ["acp"],
    });
  });
});
