import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import type { Provider } from "../../src/providers/types.js";
import { AutoModelsPanel } from "../../src/tui/auto-models.js";
import { Picker, matchesQuery, windowStart } from "../../src/tui/picker.js";
import { Sidebar } from "../../src/tui/sidebar.js";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const ESC = String.fromCharCode(27);
/** The mouse wheel turned down once, as the terminal reports it. */
const WHEEL_DOWN = `${ESC}[<65;5;5M`;

const models = [
  "gpt-6",
  "gpt-6-mini",
  "o5-pro",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-5",
  "gemini-3-pro",
  "gemini-3-flash",
  "deepseek-v4",
  "qwen3-coder-480b",
  "kimi-k3",
  "glm-5",
  "grok-5",
  "mistral-large-3",
  "llama-4-maverick",
  "minimax-m3",
  "nemotron-ultra",
  "phi-5",
];

async function until(done: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

describe("long lists", () => {
  it("scroll: the rows in view follow the one selected, and say how many are above and below", () => {
    expect(windowStart(0, 5, 18)).toBe(0);
    expect(windowStart(7, 5, 18)).toBe(3);
    expect(windowStart(17, 5, 18)).toBe(13);
    expect(matchesQuery({ id: "openrouter/qwen3-coder", label: "Qwen3 Coder" }, "qwen coder")).toBe(
      true,
    );
    expect(matchesQuery({ id: "x", label: "GPT-6 mini" }, "gpt mini")).toBe(true);
    expect(matchesQuery({ id: "x", label: "GPT-6" }, "mini")).toBe(false);
  });

  it("a long list is searched by name as you type, scrolled with the wheel, and chooses what matches", async () => {
    const chosen: string[] = [];
    const app = render(
      <Picker
        title="Model"
        rows={5}
        items={models.map((m) => ({ id: m, label: m }))}
        onSelect={(item) => chosen.push(item.id)}
        onCancel={() => undefined}
      />,
    );
    await wait();
    let screen = app.lastFrame() ?? "";
    expect(screen).toContain("18 · search: type a name");
    expect(screen).toContain("↓ 13 more");
    expect(screen).not.toContain("phi-5");
    // The wheel moves down; past the fifth row the list scrolls.
    for (let i = 0; i < 6; i++) {
      app.stdin.write(WHEEL_DOWN);
      await wait(20);
    }
    await until(() => (app.lastFrame() ?? "").includes("↑ 2 more"));
    expect(app.lastFrame()).toContain("▸ gemini-3-pro");
    // Typing searches; numbers are part of a name here, not shortcuts.
    for (const ch of "claude 5") app.stdin.write(ch);
    await until(() => (app.lastFrame() ?? "").includes("3 of 18"));
    screen = app.lastFrame() ?? "";
    expect(screen).toContain("claude-sonnet-5");
    expect(screen).not.toContain("gpt-6");
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write("\r");
    await until(() => chosen.length > 0);
    expect(chosen).toEqual(["claude-sonnet-5"]);
    app.unmount();
  });

  it("a short list keeps its number shortcuts, and no search", async () => {
    const chosen: string[] = [];
    const app = render(
      <Picker
        title="How"
        items={["a", "b", "c"].map((m) => ({ id: m, label: m }))}
        onSelect={(item) => chosen.push(item.id)}
        onCancel={() => undefined}
      />,
    );
    await wait();
    expect(app.lastFrame()).not.toContain("search:");
    app.stdin.write("2");
    await until(() => chosen.length > 0);
    expect(chosen).toEqual(["b"]);
    app.unmount();
  });

  it("an API's many models in Auto are searched by name, and marked from what matches", async () => {
    const provider: Provider = {
      id: "openrouter",
      name: "OpenRouter",
      signIn: "",
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () => Promise.resolve(models.map((m) => ({ id: m, name: m }))),
      efforts: () => [],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: () => new FakeModel({ turns: [] }),
    };
    let saved: string[] | undefined;
    const app = render(
      <AutoModelsPanel
        provider={provider}
        chosen={[]}
        onDone={(m) => {
          saved = m;
        }}
      />,
    );
    await until(() => (app.lastFrame() ?? "").includes("18 · search"));
    for (const ch of "gemini") app.stdin.write(ch);
    await until(() => (app.lastFrame() ?? "").includes("2 of 18"));
    expect(app.lastFrame()).toContain("gemini-3-flash");
    expect(app.lastFrame()).not.toContain("gpt-6");
    app.stdin.write(" ");
    await wait();
    app.stdin.write("\r");
    await until(() => saved !== undefined);
    expect(saved).toEqual(["gemini-3-pro"]);
    app.unmount();
  });
});

const grafeno = {
  mode: "external" as const,
  url: "http://grafeno.test:7810",
  namespace: "test",
  hasKey: true,
  includable: true,
  installed: false,
};

describe("local providers in the side panel", () => {
  it("show the tokens they used, never a quota", () => {
    const app = render(
      <Sidebar
        width={44}
        session={undefined}
        grafeno={grafeno}
        status={undefined}
        usage={undefined}
        models={[]}
        environment={{}}
        autoUsage={[
          {
            id: "ollama",
            name: "Ollama",
            apiKey: false,
            current: true,
            local: true,
            tokens: { input: 12_400, output: 900 },
          },
          { id: "lmstudio", name: "LM Studio", apiKey: false, current: false, local: true },
        ]}
      />,
    );
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("local · no quota · 12.4k in · 900 out");
    expect(screen).toContain("local · no quota · no tokens yet");
    expect(screen).not.toContain("does not report usage");
    app.unmount();
    const alone = render(
      <Sidebar
        width={44}
        session={undefined}
        grafeno={grafeno}
        status={undefined}
        usage={undefined}
        models={[]}
        environment={{}}
        local
      />,
    );
    const solo = (alone.lastFrame() ?? "").toLowerCase();
    expect(solo).toContain("tokens · local");
    expect(solo).toContain("no quota or credits");
    expect(solo).not.toContain("plan usage");
    expect(solo).not.toContain("checking…");
    alone.unmount();
  });
});
