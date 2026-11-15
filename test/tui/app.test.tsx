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
async function press(app: App, key: string, done: () => boolean, what: string): Promise<void> {
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

  it("turns General Auto on with /connect: a light model triages each message, answered directly or planned across providers", async () => {
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
    await until(() => now(app).includes("Auto") && !now(app).includes("checking"), "the panel");
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    app.stdin.write(ENTER);
    await until(() => seen(app).includes("General Auto: each message is triaged"), "Auto on");
    expect(saves).toEqual([{ provider: "auto" }]);

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
    await type(app, "/connect");
    app.stdin.write(ENTER);
    await until(
      () => now(app).includes("Other Provider") && now(app).includes("in use"),
      "the providers",
    );
    await until(() => !now(app).includes("checking"), "their status");
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
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
      () => now(app).includes("Run report"),
      () => `the report; the screen was:
${now(app)}`,
      45_000,
    );
    expect(now(app)).toContain(": completed");
    expect(now(app)).toContain("git merge grafeno/");
    expect(
      execFileSync("git", ["branch", "--list", "grafeno/*/integration"], {
        cwd: repo,
        encoding: "utf8",
      }),
    ).toContain("integration");
    app.unmount();
  });
});
