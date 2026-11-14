import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render as renderInk } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServices, GrafenoInfo } from "../../src/app/services.js";
import { AgentSession } from "../../src/app/session.js";
import type { Tool } from "../../src/agent/tools.js";
import type { Config } from "../../src/config.js";
import { FakeModel, type FakeTurn } from "../../src/model/index.js";
import type { ModelChoice, Provider } from "../../src/providers/types.js";
import { SessionStore } from "../../src/sessions/store.js";
import { App } from "../../src/tui/app.js";
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-tui-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a just-used folder for a moment: the system cleans temp.
  }
});

/** A provider whose models answer from a script, and which says its usage. */
function fakeProvider(turns: FakeTurn[], chosen: ModelChoice[]): Provider {
  return {
    id: "fake",
    name: "Fake Provider",
    signIn: "Sign in to the fake.",
    status: () =>
      Promise.resolve({ installed: true, signedIn: true, plan: "Fake Pro", detail: "Ready." }),
    models: () =>
      Promise.resolve([
        { id: "default", name: "Fake Default 1.0" },
        { id: "haiku", name: "Haiku 5.5", hint: "fastest" },
      ]),
    efforts: () => ["low", "medium", "high"],
    usage: () =>
      Promise.resolve({
        limits: [
          { label: "Session", used: 0.42, resets: "Nov 14, 1:19pm (Somewhere)" },
          { label: "Week (all models)", used: 0.1 },
        ],
        at: new Date(),
      }),
    modelName: (id) => `Exact ${id}`,
    create: (choice) => {
      chosen.push(choice);
      return new FakeModel({ turns });
    },
  };
}

interface Setup {
  readonly turns: FakeTurn[];
  readonly chosen?: ModelChoice[];
  readonly tools?: Tool[];
  readonly needsSetup?: boolean;
  readonly start?: () => Promise<AgentSession>;
  readonly vault?: FakeVault;
}

function services(setup: Setup): AppServices {
  const chosen = setup.chosen ?? [];
  const provider = fakeProvider(setup.turns, chosen);
  const grafeno: GrafenoInfo = {
    mode: "external",
    url: config.grafenoUrl,
    namespace: config.namespace,
    hasKey: true,
    includable: true,
    installed: false,
  };
  return {
    version: "0.0.0-test",
    settingsPath: join(dir, "config.env"),
    providers: [provider],
    needsSetup: () => setup.needsSetup === true,
    start:
      setup.start ??
      (() =>
        AgentSession.start({
          config,
          identity: { name: "grafeno-agent-test", ownOnly: true },
          vault: setup.vault ?? new FakeVault(),
          store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
          cwd: dir,
          provider,
          tools: () => setup.tools ?? [],
        })),
    grafeno: () => grafeno,
    includeGrafeno: () => Promise.resolve("included"),
    connectGrafeno: () => Promise.resolve("connected"),
    stopGrafeno: () => "stopped",
    saveChoice: () => undefined,
    upkeep: () => Promise.resolve("Memory is in order: nothing to fix."),
  };
}

/** Renders in a terminal of 120 × 60, as a real one would be. */
function render(tree: Parameters<typeof renderInk>[0]): ReturnType<typeof renderInk> {
  const app = renderInk(tree);
  Object.defineProperty(app.stdout, "rows", { value: 60, configurable: true });
  Object.defineProperty(app.stdout, "columns", { value: 120, configurable: true });
  app.stdout.emit("resize");
  return app;
}

const ENTER = "\r";
const DOWN = "\u001B[B";

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type App = ReturnType<typeof render>;
const seen = (app: App) => app.frames.join("\n");
const now = (app: App) => app.lastFrame() ?? "";

async function type(app: App, text: string): Promise<void> {
  for (const char of text) {
    app.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function ready(app: App): Promise<void> {
  await until(() => now(app).includes("Ask anything"), "the prompt");
  // The box listens to keys from the moment after it is drawn active.
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe("the terminal interface", { timeout: 20_000 }, () => {
  it("opens with the logo, the model's exact name and the side panel", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    await until(() => now(app).includes("PLAN USAGE") && now(app).includes("42%"), "the panel");
    expect(now(app)).toContain("G R A F E N O");
    expect(now(app)).toContain("Fake Default 1.0");
    expect(now(app)).toContain("grafeno-agent-test");
    expect(now(app)).toContain("Fake Provider · Fake Pro");
    app.unmount();
  });

  it("offers the commands as one types a slash, and runs the chosen one", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    await type(app, "/he");
    await until(() => now(app).includes("Commands and keys"), "the menu");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("ctrl+c          interrupt"), "the help");
    app.unmount();
  });

  it("sends a message and shows the answer and the tools used", async () => {
    const clock: Tool = {
      name: "clock",
      description: "The time.",
      inputSchema: { type: "object", properties: {} },
      writes: false,
      run: () => "noon",
    };
    const app = render(
      <App
        services={services({
          turns: [[{ call: "clock" }, { say: "It is **noon**." }]],
          tools: [clock],
        })}
      />,
    );
    await ready(app);
    await type(app, "what time is it?");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("It is"), "the answer");
    expect(seen(app)).toContain("what time is it?");
    expect(seen(app)).toContain("clock");
    app.unmount();
  });

  it("changes the model and the effort, and goes on with them", async () => {
    const chosen: ModelChoice[] = [];
    const app = render(<App services={services({ turns: [[{ say: "Answer-Zeta" }]], chosen })} />);
    await ready(app);
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Answer-Zeta"), "the first answer");
    await ready(app);
    await type(app, "/models");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Haiku 5.5"), "the model list");
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Model: Haiku 5.5"), "the model change");
    await ready(app);
    await type(app, "/effort");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Effort ·"), "the effort list");
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Effort: Medium"), "the effort change");
    await ready(app);
    await type(app, "again");
    app.stdin.write(ENTER);
    await until(() => chosen.length === 2, "a second model");
    expect(chosen).toEqual([{}, { model: "haiku", effort: "medium" }]);
    app.unmount();
  });

  it("shows the provider's real usage with /usage", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    await type(app, "/usage");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("as the provider reports it"), "the usage");
    expect(seen(app)).toContain("Week (all models)");
    expect(seen(app)).toContain("resets Nov 14, 1:19pm");
    app.unmount();
  });

  it("starts a new conversation and resumes the earlier one", async () => {
    const app = render(<App services={services({ turns: [[{ say: "noted" }]] })} />);
    await ready(app);
    await type(app, "remember the parser");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("noted"), "the answer");
    await ready(app);
    await type(app, "/new");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("New conversation"), "a new conversation");
    await ready(app);
    await type(app, "/resume");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Resume a conversation"), "the list");
    expect(now(app)).toContain("remember the parser");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Resumed: remember the parser"), "the resume");
    app.unmount();
  });

  it("asks before a tool that needs permission, and tells the model the answer", async () => {
    const note: Tool = {
      name: "write_note",
      description: "Writes a note.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      writes: true,
      describe: () => "write a note",
      run: () => "written",
    };
    const app = render(
      <App
        services={services({
          turns: [
            [
              { call: "write_note", input: { text: "x" } },
              { say: (c) => `result: ${c.results[0]?.content ?? ""}` },
            ],
          ],
          tools: [note],
        })}
      />,
    );
    await ready(app);
    await type(app, "write it");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Permission needed"), "the question");
    expect(now(app)).toContain("write a note");
    app.stdin.write("y");
    await until(() => seen(app).includes("result: written"), "the answer");
    app.unmount();
  });

  it("guides the first run: memory, then the provider", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]], needsSetup: true })} />);
    await until(() => now(app).includes("Include Grafeno"), "the memory choice");
    expect(now(app)).toContain("Connect to a Grafeno server");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("More providers will appear here"), "the provider step");
    await until(() => now(app).includes("Signed in · Fake Pro"), "the provider status");
    app.stdin.write(ENTER);
    await ready(app);
    expect(seen(app)).toContain("included");
    app.unmount();
  });

  it("works without a connection and says what to do", async () => {
    const app = render(
      <App
        services={services({
          turns: [],
          start: () =>
            Promise.reject(new Error("Grafeno does not answer at http://grafeno.test:7810.")),
        })}
      />,
    );
    await until(() => seen(app).includes("Grafeno does not answer"), "the error");
    await until(() => now(app).includes("Not connected ·"), "the offline prompt");
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Not connected yet"), "the refusal");
    app.unmount();
  });
});

describe("memory in the interface", { timeout: 20_000 }, () => {
  it("shows what memory recalled for a message, under it and in the panel", async () => {
    const vault = new FakeVault({
      context: () => ({
        text: "## Memory\n[1] Parser design (Decision; stated)\nThe parser uses a Pratt design.\n\n## Facts\n- “Parser design” part_of demo",
        isError: false,
      }),
    });
    const app = render(<App services={services({ turns: [[{ say: "Pratt it is." }]], vault })} />);
    await ready(app);
    await type(app, "which parser design?");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Pratt it is."), "the answer");
    expect(seen(app)).toContain("1 recalled, 1 fact · Parser design");
    await until(() => now(app).includes("last message: 1 recalled"), "the panel");
    app.unmount();
  });
});
