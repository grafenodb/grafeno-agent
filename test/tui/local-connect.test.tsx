import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCommand } from "../../src/app/local-command.js";
import { registerLocalConnections } from "../../src/providers/index.js";
import { builtInConnections, loadLocalConnections } from "../../src/providers/local/store.js";
import { LocalPanel, type LocalPanelProps } from "../../src/tui/local-connect.js";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";

/** Waits until a condition holds (the screen updates on its own time). */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

/** Presses a key until it is taken (a box listens only once it is drawn). */
async function press(
  app: { stdin: { write: (s: string) => void } },
  key: string,
  taken: () => boolean,
): Promise<void> {
  const end = Date.now() + 5000;
  while (!taken()) {
    if (Date.now() > end) throw new Error(`the key ${JSON.stringify(key)} was not taken`);
    app.stdin.write(key);
    await wait(120);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("/connect · Local models / Self-hosted", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-local-ui-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds Ollama: its address (checked), then its default model among those it lists", async () => {
    const asked: string[] = [];
    const saved: unknown[] = [];
    const done: string[] = [];
    const actions: LocalPanelProps["actions"] = {
      checkServer: (kind, url) => {
        asked.push(`${kind} ${url}`);
        return Promise.resolve({
          ok: true,
          url,
          locality: "local",
          found: {
            reachable: true,
            version: "0.12.3",
            models: [
              { id: "qwen3:8b", name: "qwen3:8b", tools: true, contextLength: 40960, loaded: true },
              { id: "gemma3:4b", name: "gemma3:4b", tools: false },
            ],
          },
        });
      },
      saveServer: (server) => {
        saved.push(server);
        return Promise.resolve({ id: "ollama", message: "Ollama is connected." });
      },
      setServerModel: () => "",
      removeServer: () => Promise.resolve(""),
    };
    const app = render(
      <LocalPanel
        actions={actions}
        file={join(dir, "local-connections.json")}
        onUse={() => undefined}
        onCancel={() => undefined}
        onDone={(message) => {
          if (message) done.push(message);
        }}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("+ Bionic"));
    const list = app.lastFrame() ?? "";
    expect(list).toContain("Local models / Self-hosted");
    expect(list).toContain("ollama · Ollama");
    expect(list).toContain("+ Custom OpenAI-compatible endpoint");
    // 1 use, 2 ollama, 3 lmstudio, 4 + Ollama: chosen by its number.
    await press(app, "4", () => (app.lastFrame() ?? "").includes("Ollama · its address"));
    expect(app.lastFrame()).toContain("http://localhost:11434");
    await press(app, ENTER, () => asked.length > 0);
    expect(asked).toEqual(["ollama http://localhost:11434"]);
    await until(() => (app.lastFrame() ?? "").includes("2 models"));
    const models = app.lastFrame() ?? "";
    expect(models).toContain("answers at http://localhost:11434 (on this computer): 2 models");
    expect(models).toContain("tools · 40k context · loaded");
    expect(models).toContain("no tools");
    // 1 no default, 2 qwen3:8b.
    await press(app, "2", () => saved.length > 0);
    await until(() => done.length > 0);
    expect(saved).toEqual([
      expect.objectContaining({
        kind: "ollama",
        url: "http://localhost:11434",
        defaultModel: "qwen3:8b",
      }),
    ]);
    expect(done).toEqual(["Ollama is connected."]);
    app.unmount();
  });

  it("a connection is made the chat's model from its own actions", async () => {
    const used: string[] = [];
    const actions: LocalPanelProps["actions"] = {
      checkServer: () => Promise.resolve({ ok: false, message: "not asked" }),
      saveServer: () => Promise.resolve({ id: "x", message: "" }),
      setServerModel: () => "",
      removeServer: () => Promise.resolve(""),
    };
    const app = render(
      <LocalPanel
        actions={actions}
        file={join(dir, "local-connections.json")}
        onUse={() => undefined}
        onUseConnection={(id) => used.push(id)}
        onCancel={() => undefined}
        onDone={() => undefined}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("lmstudio · LM Studio"));
    // 1 use, 2 ollama, 3 lmstudio: its actions, the first of which makes it the chat's.
    await press(app, "3", () => (app.lastFrame() ?? "").includes("Use it for the chat"));
    expect(app.lastFrame()).toContain("the main model");
    await press(app, ENTER, () => used.length > 0);
    expect(used).toEqual(["lmstudio"]);
    app.unmount();
  });
});

describe("grafeno-agent local", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-local-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    registerLocalConnections(builtInConnections());
  });

  it("adds a server after checking it, never takes a key on the command line, and removes it", async () => {
    const file = join(dir, "local-connections.json");
    const said: string[] = [];
    const io = {
      say: (line: string) => said.push(line),
      confirm: () => Promise.resolve(true),
      env: { CUSTOM_KEY: "ck-1", GRAFENO_AGENT_DATA: dir },
      file,
      fetch: ((url: string) =>
        Promise.resolve(
          url.endsWith("/v1/models") ? json({ data: [{ id: "my-model" }] }) : json({}, 404),
        )) as typeof fetch,
    };
    expect(await localCommand(["add", "bionic", "https://b.example.com/v1"], io)).toBe(2);
    expect(said.at(-1)).toContain("needs a key");
    expect(
      await localCommand(
        [
          "add",
          "openai-compatible",
          "http://localhost:8080/v1",
          "--id",
          "llamacpp",
          "--model",
          "my-model",
        ],
        io,
      ),
    ).toBe(0);
    expect(loadLocalConnections(file).find((c) => c.id === "llamacpp")).toMatchObject({
      kind: "openai-compatible",
      url: "http://localhost:8080/v1",
      defaultModel: "my-model",
    });
    expect(await localCommand(["check", "llamacpp"], io)).toBe(0);
    expect(said.join("\n")).toContain("★ my-model  tools unknown");
    expect(await localCommand(["remove", "llamacpp", "--yes"], io)).toBe(0);
    expect(loadLocalConnections(file).some((c) => c.id === "llamacpp")).toBe(false);
  });
});
