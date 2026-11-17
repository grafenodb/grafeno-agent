import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
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
let autoBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-tui-"));
  // Auto with one provider in it: its tests need one (by default it has none).
  autoBefore = process.env.AGENT_AUTO_PROVIDERS;
  process.env.AGENT_AUTO_PROVIDERS = "claude-code";
});
afterEach(() => {
  if (autoBefore === undefined) Reflect.deleteProperty(process.env, "AGENT_AUTO_PROVIDERS");
  else process.env.AGENT_AUTO_PROVIDERS = autoBefore;
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
  readonly orchestrator?: AppServices["orchestrator"];
  /** General Auto's triage, for the test: default, answer directly. */
  readonly triage?: AppServices["triage"];
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
      ((extra) =>
        AgentSession.start({
          ...(extra?.tools ? { extraTools: extra.tools } : {}),
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
    orchestrator: setup.orchestrator ?? (() => Promise.reject(new Error("no orchestrator here"))),
    pool: () => Promise.resolve([{ provider }]),
    triage: setup.triage ?? (() => Promise.resolve({ route: "direct", reason: "a test" })),
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

async function until(
  check: () => boolean,
  what: string | (() => string),
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type App = ReturnType<typeof render>;

/** Presses a key, again every half second, until `done`: a key sent before a menu listens is lost. */
async function press(
  app: App,
  key: string,
  done: () => boolean,
  what: string | (() => string),
): Promise<void> {
  for (let tries = 0; tries < 20 && !done(); tries++) {
    app.stdin.write(key);
    await until(done, what, 500).catch(() => undefined);
  }
  await until(done, what, 1);
}
const seen = (app: App) => app.frames.join("\n");
const now = (app: App) => app.lastFrame() ?? "";

async function type(app: App, text: string): Promise<void> {
  for (const char of text) {
    app.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A left click on the first place `text` shows on the screen, as the terminal reports it. */
function clickOn(app: App, text: string): void {
  const lines = now(app)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n");
  const row = lines.findIndex((line) => line.includes(text));
  if (row < 0) throw new Error(`"${text}" is not on the screen:\n${lines.join("\n")}`);
  const column = (lines[row] ?? "").indexOf(text) + 1;
  app.stdin.write(`\u001B[<0;${String(column + 1)};${String(row + 1)}M`);
  app.stdin.write(`\u001B[<0;${String(column + 1)};${String(row + 1)}m`);
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

  it("turns General Auto on with /mode, by hand: a light model triages each message, answered directly or planned across providers", async () => {
    const asked: string[] = [];
    const pooled: (boolean | undefined)[] = [];
    const saves: Record<string, unknown>[] = [];
    const base = services({
      turns: [[{ say: "Direct-Answer" }]],
      triage: (message) => {
        asked.push(message);
        return Promise.resolve(
          message.startsWith("Build")
            ? { route: "orchestrate", reason: "an API, a UI and tests", by: "codex/luna" }
            : { route: "direct", reason: "a question", by: "codex/luna" },
        );
      },
      orchestrator: (_extra, auto) => {
        pooled.push(auto);
        const planned = {
          plan: {
            goal: "Orders, end to end",
            risks: [],
            tasks: [
              {
                id: "api",
                title: "The API",
                kind: "backend",
                dependsOn: [],
              },
            ],
          },
          order: ["api"],
          attempts: 1,
          routes: new Map([
            [
              "api",
              { kind: "run", tier: "deep", model: "big", reasons: [], provider: "claude-code" },
            ],
          ]),
          planner: "claude-code/mid · high",
        };
        return Promise.resolve({
          plan: () => Promise.resolve(planned),
          close: () => undefined,
          policy: { mode: "controlled" },
        } as unknown as Orchestrator);
      },
    });
    const svc: AppServices = {
      ...base,
      saveChoice: (choice) => {
        saves.push(choice);
      },
    };
    const app = render(<App services={svc} />);
    await ready(app);
    await type(app, "/connect");
    app.stdin.write(ENTER);
    // The menu first: how to connect, five choices; 2 opens the API Key section.
    await until(() => now(app).includes("Connect · choose how"), "the menu");
    expect(now(app)).toContain("1. CLI / Subscription");
    expect(now(app)).toContain("3. Coding Plan");
    await press(
      app,
      "2",
      () => !now(app).includes("Connect · choose how") && now(app).includes("API Key"),
      () => `the API Key section; screen: ${now(app)}`,
    );
    await until(
      () => now(app).includes("No model") && !now(app).includes("checking"),
      () => `the panel; screen: ${now(app)}`,
    );
    // Auto is not switched on here any more: /mode does it, by hand.
    expect(now(app)).not.toMatch(/▸ Auto|Auto · in use/);
    await press(app, "\u001B", () => now(app).includes("Connect · choose how"), "the menu");
    await press(app, "\u001B", () => now(app).includes("Ask anything"), "the chat");
    await type(app, "/mode");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Specific ·"), "the modes");
    expect(now(app)).toContain("the provider chosen in /connect");
    // 1 Auto, 2 Specific: chosen by its number.
    await press(
      app,
      "1",
      () => seen(app).includes("General Auto: each message is triaged"),
      "Auto on",
    );
    expect(saves).toEqual([{ mode: "auto" }]);

    await ready(app);
    await type(app, "what does this repo do?");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Direct-Answer"), "the direct answer");
    expect(seen(app)).toContain("Auto: answering directly (a question) · codex/luna");

    await ready(app);
    await type(app, "Build the orders API with a UI and tests");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Run this plan?"), "the plan");
    expect(seen(app)).toContain("Auto: a plan across providers (an API, a UI and tests)");
    expect(seen(app)).toContain("Planned by claude-code/mid · high");
    expect(pooled).toEqual([true]);
    expect(asked).toEqual(["what does this repo do?", "Build the orders API with a UI and tests"]);
    app.unmount();
  });

  it("changes the provider with /connect: the conversation goes on with it, model Auto", async () => {
    const firstChosen: ModelChoice[] = [];
    const otherChosen: ModelChoice[] = [];
    const base = services({ turns: [[{ say: "From-First" }]], chosen: firstChosen });
    const other: Provider = {
      ...fakeProvider(
        [
          [
            {
              say: (c) =>
                `From-Other ${c.message.includes("From-First") ? "with the conversation" : "alone"}`,
            },
          ],
        ],
        otherChosen,
      ),
      id: "other",
      name: "Other Provider",
    };
    const saves: Record<string, unknown>[] = [];
    const svc: AppServices = {
      ...base,
      providers: [...base.providers, other],
      saveChoice: (choice) => {
        saves.push(choice);
      },
    };
    const app = render(<App services={svc} />);
    await ready(app);
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("From-First"), "the first answer");
    await ready(app);
    // Straight to a section: /connect api.
    await type(app, "/connect api");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Other Provider"), "the providers");
    await until(() => !now(app).includes("checking"), "their status");
    // Down to the last row: Auto, then the first provider, then the other one.
    for (let i = 0; i < 3; i++) {
      app.stdin.write(DOWN);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    app.stdin.write(ENTER);
    await until(
      () => seen(app).includes("Provider: Other Provider, model Auto"),
      "the provider change",
    );
    expect(saves).toEqual([{ provider: "other" }]);
    await ready(app);
    await type(app, "and now?");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("From-Other with the conversation"), "the other's answer");
    expect(otherChosen).toEqual([{}]);
    app.unmount();
  });

  it("goes back a step with esc in /connect: a section to its menu, the menu to the chat", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    await type(app, "/connect api");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("API Key"), "the section");
    await press(app, "\u001B", () => now(app).includes("Connect · choose how"), "the menu again");
    expect(now(app)).not.toContain("Ask anything");
    await press(app, "\u001B", () => now(app).includes("Ask anything"), "the chat");
    app.unmount();
  });

  it("/mode specific with no provider chosen yet: no model, said, and messages are refused", async () => {
    const saves: Record<string, unknown>[] = [];
    const base = services({ turns: [[{ say: "Should-Not-Answer" }]] });
    const app = render(
      <App
        services={{
          ...base,
          saveChoice: (choice) => {
            saves.push(choice);
          },
        }}
      />,
    );
    await ready(app);
    await type(app, "/mode specific");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("No provider is chosen for the chat yet"), "the warning");
    expect(saves).toEqual([{ mode: "specific" }]);
    await ready(app);
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("No model is selected"), "the refusal");
    expect(seen(app)).not.toContain("Should-Not-Answer");
    app.unmount();
  });

  it("no model at all, chosen in /connect: each message is refused, nothing is sent", async () => {
    const saves: Record<string, unknown>[] = [];
    const base = services({ turns: [[{ say: "Should-Not-Answer" }]] });
    const svc: AppServices = {
      ...base,
      saveChoice: (choice) => {
        saves.push(choice);
      },
    };
    const app = render(<App services={svc} />);
    await ready(app);
    await type(app, "/connect api");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("No model"), "the no model row");
    // Searching "no model" leaves it the first row.
    await type(app, "no model");
    await until(() => now(app).includes("▸ No model"), "it selected");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("No model is selected"), "the warning");
    expect(saves).toContainEqual({ provider: "none" });
    await ready(app);
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(
      () => (seen(app).match(/No model is selected/g)?.length ?? 0) >= 2,
      "the message refused",
    );
    expect(seen(app)).not.toContain("Should-Not-Answer");
    app.unmount();
  });

  it("switching off the provider in use leaves the chat with no model at once", async () => {
    const base = services({ turns: [[{ say: "Should-Not-Answer" }]] });
    const svc: AppServices = {
      ...base,
      connections: {
        setEnabled: (id: string, on: boolean) => {
          process.env[`PROVIDER_${id.toUpperCase()}_ENABLED`] = on ? "true" : "false";
          return `${id} is switched ${on ? "on" : "off"}.`;
        },
      } as unknown as NonNullable<AppServices["connections"]>,
    };
    try {
      const app = render(<App services={svc} />);
      await ready(app);
      await type(app, "/connect manage");
      app.stdin.write(ENTER);
      await until(() => now(app).includes("Manage connections"), "the connections");
      await press(app, ENTER, () => now(app).includes("Switch off"), "its actions");
      await press(
        app,
        ENTER,
        () => seen(app).includes("was the chat's model: no model is selected now"),
        "the chat left it",
      );
      await press(app, "\u001B", () => now(app).includes("Connect · choose how"), "the menu");
      await press(app, "\u001B", () => now(app).includes("Ask anything"), "the chat");
      await type(app, "hello");
      app.stdin.write(ENTER);
      await until(() => seen(app).includes("Fake Provider is switched off"), "the refusal");
      expect(seen(app)).not.toContain("Should-Not-Answer");
      app.unmount();
    } finally {
      Reflect.deleteProperty(process.env, "PROVIDER_FAKE_ENABLED");
    }
  });

  it("asks the provider anew for its usage after each turn, since the turn spent some", async () => {
    const base = services({ turns: [[{ say: "Answered" }]] });
    const asked: ({ fresh?: boolean } | undefined)[] = [];
    // The session uses this very provider: its usage is counted in place.
    const provider = base.providers[0] as Provider;
    const original = provider.usage.bind(provider);
    (provider as { usage: Provider["usage"] }).usage = (options) => {
      asked.push(options);
      return original(options);
    };
    const app = render(<App services={base} />);
    await ready(app);
    asked.length = 0;
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Answered"), "the answer");
    await until(() => asked.length > 0, "a reading after the turn");
    expect(asked).toContainEqual({ fresh: true });
    app.unmount();
  });

  it("tells the model to answer in the language the user writes in", async () => {
    const app = render(
      <App
        services={services({
          turns: [
            [
              {
                say: (c) =>
                  c.message.includes("[The user writes in Spanish") ? "En-Espanol" : "Sin-Nota",
              },
            ],
            [
              {
                say: (c) =>
                  c.message.includes("[The user writes in English") ? "In-English" : "No-Note",
              },
            ],
          ],
        })}
      />,
    );
    await ready(app);
    await type(app, "¿Puedes crear una carpeta para los tests?");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("En-Espanol"), "the Spanish answer");
    await ready(app);
    await type(app, "Now add a file with the function");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("In-English"), "the English answer");
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

  it("lists Grafeno's own MCP server with /mcp, always on, and the plugins with /plugins", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    await type(app, "/mcp");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("built in · always on"), "the MCP servers");
    expect(seen(app)).toMatch(/grafeno\s+\d+ tools? · built in · always on/);
    await ready(app);
    await type(app, "/plugins");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("No plugin is on"), "the plugins");
    expect(seen(app)).toContain("grafeno-agent plugins enable github");
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
    await until(() => now(app).includes("Conversations of this project"), "the list");
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
    // Enter is not an answer (a message being typed when the request appears), however long
    // after it shows. (A key pressed the moment it shows is no answer either; how long that
    // moment lasts depends on the machine's load, so it is not timed here.)
    app.stdin.write(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(now(app)).toContain("Permission needed");
    expect(now(app)).toContain("enter does not answer");
    // A key in the moment after it shows is no answer: pressed again until it is taken.
    await press(app, "y", () => seen(app).includes("result: written"), "the answer");
    expect(seen(app)).toContain("Allowed: write a note");
    app.unmount();
  });

  it("/permissions: skipped for this session, a tool runs without asking; unattended says so", async () => {
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
            [
              {
                say: (c) =>
                  c.message.includes("[Unattended: nobody is watching") ? "Alone-OK" : "Not-told",
              },
            ],
          ],
          tools: [note],
        })}
      />,
    );
    await ready(app);
    await type(app, "/permissions");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Skip permissions"), "the modes");
    expect(now(app)).toContain("Automatic");
    // Down twice: Skip permissions; then the scope: This session.
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(ENTER);
    await until(() => now(app).includes("for what?"), "the scopes");
    expect(now(app)).toContain("This session and its sub-agents");
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(ENTER);
    await until(
      () => seen(app).includes("Permissions: Skip permissions, this session."),
      "the choice",
    );
    await until(() => now(app).includes("permissions: skip permissions"), "the footer");
    await ready(app);
    await type(app, "write it");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("result: written"), "the answer");
    expect(seen(app)).not.toContain("Permission needed");

    await ready(app);
    await type(app, "/unattended");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("UNATTENDED"), "the unattended badge");
    await ready(app);
    await type(app, "keep going with the task");
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("Alone-OK"), "the model told it is unattended");
    app.unmount();
  });

  it("does with a click what the commands do: the menu bar, a list's rows, the permission buttons", async () => {
    const note: Tool = {
      name: "write_note",
      description: "Writes a note.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      writes: true,
      describe: () => "write a note",
      run: () => "written",
    };
    const chosen: ModelChoice[] = [];
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
          chosen,
        })}
      />,
    );
    await ready(app);
    // The menu bar: [Model] opens the list of models, as /models does.
    expect(now(app)).toContain("[New]");
    clickOn(app, "[Model]");
    await until(
      () => now(app).includes("Haiku 5.5") && now(app).includes("click choose"),
      "the models",
    );
    // A row of the list: chosen with a click.
    clickOn(app, "Haiku 5.5");
    await until(() => seen(app).includes("Model: Haiku 5.5"), "the model chosen by a click");
    // The list's own cancel, and the help button.
    await ready(app);
    clickOn(app, "[Effort]");
    await until(() => now(app).includes("esc cancel"), "the efforts");
    clickOn(app, "esc cancel");
    await ready(app);
    clickOn(app, "[Help]");
    await until(() => seen(app).includes("/permissions"), "the help");
    // A permission request: answered with its button, after the moment it takes no answer.
    await type(app, "write it");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Permission needed"), "the question");
    await new Promise((resolve) => setTimeout(resolve, 700));
    // Clicked again until taken: a click in the moment after it shows is no answer.
    for (let tries = 0; tries < 10 && !seen(app).includes("result: written"); tries++) {
      if (now(app).includes("y allow")) clickOn(app, "y allow");
      await until(() => seen(app).includes("result: written"), "the answer", 500).catch(
        () => undefined,
      );
    }
    await until(() => seen(app).includes("result: written"), "the answer", 1);
    expect(seen(app)).toContain("Allowed: write a note");
    app.unmount();
  });

  it("menus: the same button closes its menu, another moves to it, and Esc only closes", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]] })} />);
    await ready(app);
    clickOn(app, "[Model]");
    await until(() => now(app).includes("Haiku 5.5"), "the models");
    // Another button: its menu takes the place of the one open.
    clickOn(app, "[Effort]");
    await until(
      () => now(app).includes("Effort ·") && !now(app).includes("Haiku 5.5"),
      "the efforts",
    );
    // The same button again: the menu closes.
    clickOn(app, "[Effort]");
    await until(() => now(app).includes("Ask anything"), "the menu closed");
    // Esc closes a menu and does nothing else.
    clickOn(app, "[Model]");
    await until(() => now(app).includes("Haiku 5.5"), "the models again");
    app.stdin.write("");
    await until(() => now(app).includes("Ask anything"), "closed by esc");
    expect(seen(app)).not.toContain("Pausing the run");
    app.unmount();
  });

  it("guides the first run: memory, then the provider", async () => {
    const app = render(<App services={services({ turns: [[{ say: "hi" }]], needsSetup: true })} />);
    await until(() => now(app).includes("The agent's own Grafeno"), "the memory choice");
    expect(now(app)).toContain("Connect to a Grafeno server");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("The chat uses the one chosen here"), "the provider step");
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

describe("orchestration in the interface", { timeout: 60_000 }, () => {
  it("plans a request, runs it after the user says so, shows the run and its report", async () => {
    const repo = join(dir, "project");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "# p\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    const plan = {
      goal: "Two files",
      risks: [],
      tasks: ["alpha", "beta"].map((id) => ({
        id,
        title: `Write ${id}`,
        description: `Create ${id}.txt.`,
        kind: "docs",
        dependsOn: [],
        complexity: 1,
        capabilities: ["code"],
        touches: [`${id}.txt`],
        acceptance: [{ check: "files", exist: [`${id}.txt`] }],
        parallelSafe: true,
      })),
    };
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      signIn: "",
      tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () => Promise.resolve([{ id: "m", name: "M" }]),
      efforts: () => [],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: () =>
        new FakeModel({
          turns: [
            (context) => {
              if (context.system.includes("You are the planner")) {
                return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
              }
              const file = /these files exist: (\S+)/.exec(context.message)?.[1] ?? "x.txt";
              return [
                { call: "write_file", input: { path: file, content: "ok\n" } },
                { say: "done" },
              ];
            },
          ],
        }),
    };
    const app = render(
      <App
        services={services({
          turns: [[{ say: "hi" }]],
          orchestrator: (extra) =>
            Promise.resolve(
              new Orchestrator({
                provider,
                project: { name: "p", path: repo },
                projectRoot: repo,
                dataDir: join(dir, "data"),
                ...extra,
              }),
            ),
        })}
      />,
    );
    await ready(app);
    await type(app, "/orchestrate write alpha and beta");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Run this plan?"), "the plan");
    expect(seen(app)).toContain("Goal: Two files");
    expect(seen(app)).toContain("Write alpha");
    // Under load a key can arrive before the menu listens for keys (it starts
    // listening after it is drawn): the choice is pressed until the menu closes.
    await press(app, ENTER, () => !now(app).includes("Run this plan?"), "the run to start");
    // The last frame, not every frame: joining them all each time slows the run itself.
    await until(
      () => now(app).includes("Run details"),
      () => `the report; the screen was:
${now(app)}`,
      45_000,
    );
    // The result first, each task with what it did; the details folded under it.
    expect(now(app)).toContain("Done: 2 of 2 tasks done.");
    expect(now(app)).toContain("✓ Write alpha");
    expect(now(app)).toContain("git merge grafeno/");
    expect(now(app)).toContain("▸ Run details");
    expect(now(app)).not.toContain(": completed");
    expect(
      execFileSync("git", ["branch", "--list", "grafeno/*/integration"], {
        cwd: repo,
        encoding: "utf8",
      }),
    ).toContain("integration");
    app.unmount();
  });
});

/** A git project and a fake provider whose planner splits the work in two files. */
function subagentWorld(): { repo: string; workers: Provider } {
  const repo = join(dir, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README.md"), "# p\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  const plan = {
    goal: "Two files",
    risks: [],
    tasks: ["alpha", "beta"].map((id) => ({
      id,
      title: `Write ${id}`,
      description: `Create ${id}.txt.`,
      kind: "docs",
      dependsOn: [],
      complexity: 1,
      capabilities: ["code"],
      touches: [`${id}.txt`],
      acceptance: [{ check: "files", exist: [`${id}.txt`] }],
      parallelSafe: true,
    })),
  };
  const workers: Provider = {
    id: "fake-workers",
    name: "Fake workers",
    signIn: "",
    tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
    models: () => Promise.resolve([{ id: "m", name: "M" }]),
    efforts: () => [],
    usage: () => Promise.resolve(undefined),
    modelName: (id) => id,
    create: () =>
      new FakeModel({
        turns: [
          (context) => {
            if (context.system.includes("You are the planner")) {
              return [{ say: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }];
            }
            const file = /these files exist: (\S+)/.exec(context.message)?.[1] ?? "x.txt";
            return [
              { say: `Writing ${file} now.` },
              { call: "write_file", input: { path: file, content: "ok\n" } },
              { say: "done" },
            ];
          },
        ],
      }),
  };
  return { repo, workers };
}

describe("sub-agents in the interface", { timeout: 90_000 }, () => {
  it("lets the main agent start sub-agents, lists them on the left, and shows each read only", async () => {
    const { repo, workers } = subagentWorld();
    const extras: Record<string, unknown>[] = [];
    const app = render(
      <App
        services={services({
          // The main agent hands the work to sub-agents, then reads their report.
          turns: [
            [
              { call: "delegate", input: { request: "Write alpha.txt and beta.txt" } },
              {
                say: (context) => `Report: ${context.results[0]?.content.split("\n", 1)[0] ?? ""}`,
              },
            ],
          ],
          orchestrator: (extra) => {
            extras.push({ ...extra });
            return Promise.resolve(
              new Orchestrator({
                ...extra,
                provider: workers,
                providers: [workers],
                project: { name: "p", path: repo },
                projectRoot: repo,
                dataDir: join(dir, "data"),
              }),
            );
          },
        })}
      />,
    );
    await ready(app);
    // The side panel off: the agents panel has room on 120 columns.
    app.stdin.write("\u0002");
    await type(app, "build both files");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Run this plan?"), "the plan");
    expect(seen(app)).toContain("Plan for sub-agents");
    await press(app, ENTER, () => !now(app).includes("Run this plan?"), "the run to start");
    await until(
      () => now(app).includes("AGENTS") && now(app).includes("alpha") && now(app).includes("beta"),
      () => `the agents panel; the screen was:\n${now(app)}`,
      45_000,
    );
    expect(now(app)).toContain("Orchestrator");
    // Sub-agents hang from it as a tree, titled by their task.
    expect(now(app)).toMatch(/[├└]─/);
    expect(now(app)).toContain("Write alpha");
    // The main agent gets the report as its tool's answer.
    await until(
      () => now(app).includes("Report: The sub-agents' run ended: completed."),
      () => `the main agent's report; the screen was:\n${now(app)}`,
      45_000,
    );
    // ctrl+n: the first sub-agent, read only, with what it did.
    app.stdin.write("\u000e");
    await until(
      () => now(app).includes("read only"),
      () => `a sub-agent's view; the screen was:\n${now(app)}`,
    );
    expect(now(app)).toContain("Writing alpha.txt now.");
    // Which one is on screen is said plainly: a band at the bottom, and ▌ on the left.
    expect(now(app)).toMatch(/Viewing \S+\s+1 of 2/);
    expect(now(app)).toContain("▌");
    // A finished sub-agent's summary is not shown as a warning.
    expect(now(app)).not.toContain("now.done");
    expect(now(app)).toContain("alpha.txt");
    expect(now(app)).not.toContain("Ask anything");
    // ctrl+p: back to the main agent and its prompt.
    app.stdin.write("\u0010");
    await until(() => now(app).includes("Ask anything"), "the main agent's prompt");
    // In Auto (nothing set), sub-agents are not pinned to the chat's provider.
    expect(extras[0]?.provider).toBeUndefined();
    app.unmount();
  });
});

describe("unattended operation", { timeout: 90_000 }, () => {
  it("runs the main agent's plan without asking, with sub-agents' permissions skipped and the run extended", async () => {
    const { repo, workers } = subagentWorld();
    const extras: Record<string, unknown>[] = [];
    const app = render(
      <App
        services={services({
          turns: [
            [
              { call: "delegate", input: { request: "Write alpha.txt and beta.txt" } },
              {
                say: (context) => `Report: ${context.results[0]?.content.split("\n", 1)[0] ?? ""}`,
              },
            ],
          ],
          orchestrator: (extra) => {
            extras.push({ ...extra });
            return Promise.resolve(
              new Orchestrator({
                ...extra,
                provider: workers,
                providers: [workers],
                project: { name: "p", path: repo },
                projectRoot: repo,
                dataDir: join(dir, "data"),
              }),
            );
          },
        })}
      />,
    );
    await ready(app);
    await type(app, "/unattended");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("UNATTENDED"), "unattended on");
    await ready(app);
    await type(app, "build both files");
    app.stdin.write(ENTER);
    await until(
      () => now(app).includes("Report: The sub-agents' run ended: completed."),
      () => `the report; the screen was:\n${now(app)}`,
      60_000,
    );
    expect(seen(app)).toContain("Unattended: the plan runs without asking.");
    expect(seen(app)).not.toContain("Run this plan?");
    expect(extras[0]).toMatchObject({ permissions: "skip", mode: "extended" });
    app.unmount();
  });
});

describe("Auto with no provider in it", { timeout: 20_000 }, () => {
  it("says so, and the chat answers with its own provider", async () => {
    process.env.AGENT_AUTO_PROVIDERS = "";
    const asked: string[] = [];
    const app = render(
      <App
        services={services({
          turns: [[{ say: "Answered-Directly" }]],
          triage: (message) => {
            asked.push(message);
            return Promise.resolve({ route: "direct", reason: "x" });
          },
        })}
      />,
    );
    await ready(app);
    await type(app, "hello");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("Answered-Directly"), "the answer");
    expect(seen(app)).toContain("Auto includes no provider yet");
    // No triage: Auto had nothing to choose from.
    expect(asked).toEqual([]);
    app.unmount();
  });
});

describe("folded actions", { timeout: 20_000 }, () => {
  it("finished actions fold into a line; ctrl+o or a click unfolds them; the turn closes with its result", async () => {
    const reader = (name: string): Tool => ({
      name,
      description: "Reads.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      writes: false,
      run: (input) => `contents of ${String(input.path)}\nsecond line`,
    });
    const app = render(
      <App
        services={services({
          turns: [
            [
              { call: "read_file", input: { path: "a.ts" } },
              { call: "read_file", input: { path: "b.ts" } },
              { call: "run_command", input: { command: "npm test" } },
              { say: "All good: both files read, tests pass." },
            ],
          ],
          tools: [reader("read_file"), reader("run_command")],
        })}
      />,
    );
    await ready(app);
    await type(app, "check it");
    app.stdin.write(ENTER);
    await until(() => now(app).includes("All good"), "the answer");
    await until(() => now(app).includes("Worked for"), "the result line");
    const folded = now(app);
    expect(folded).toContain("Read 2 files, ran a command ▸");
    expect(folded).toMatch(/Worked for \d+s · read 2 files, ran a command/);
    expect(folded).not.toContain("contents of a.ts");
    app.stdin.write("\u000F"); // ctrl+o
    await until(() => now(app).includes("contents of a.ts"), "the actions unfolded");
    expect(now(app)).toContain("npm test");
    expect(now(app)).toContain("▾");
    app.stdin.write("\u000F");
    await until(() => !now(app).includes("contents of a.ts"), "folded again");
    clickOn(app, "Read 2 files");
    await until(() => now(app).includes("contents of b.ts"), "unfolded by a click");
    app.unmount();
  });
});
