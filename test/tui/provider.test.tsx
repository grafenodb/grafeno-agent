import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import type { Provider } from "../../src/providers/types.js";
import { matchesProvider, ProviderPanel } from "../../src/tui/provider.js";

function fake(id: string, name: string): Provider {
  return {
    id,
    name,
    signIn: "sign in",
    status: () => Promise.resolve({ installed: true, signedIn: true, detail: "Ready." }),
    models: () => Promise.resolve([]),
    efforts: () => [],
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () => new FakeModel({ turns: [] }),
  };
}

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("/connect and Auto", () => {
  it("marks what Auto includes, says which use an API key, and space toggles one", async () => {
    const toggled: string[] = [];
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude"), fake("openrouter", "OpenRouter")]}
        auto
        onAuto={() => undefined}
        autoMembers={["claude-code"]}
        apiKeyProviders={["openrouter"]}
        onToggleAuto={(id) => toggled.push(id)}
        onDone={() => undefined}
      />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen).toMatch(/Claude.*\[✓ in Auto\]/);
    expect(screen).toMatch(/OpenRouter.*\[ {2}not in Auto\]/);
    expect(screen).toContain("API key: may bill per token");
    expect(screen).toContain("space in Auto or not");
    expect(screen).toContain("(claude-code)");
    // Auto is the first row, above every provider, and in use here: it is where the panel opens.
    expect(screen.indexOf("Auto · in use")).toBeLessThan(screen.indexOf("Claude"));
    // Down past Claude to OpenRouter, then space: it is offered to Auto.
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write(" ");
    await wait();
    expect(toggled).toEqual(["openrouter"]);
    app.unmount();
  });

  it("searches providers by name as you type, and esc clears the search", async () => {
    const chosen: string[] = [];
    const app = render(
      <ProviderPanel
        providers={[
          fake("claude-code", "Claude"),
          fake("codex", "Codex"),
          fake("openrouter", "OpenRouter"),
        ]}
        onDone={(_status, provider) => {
          if (provider) chosen.push(provider.id);
        }}
      />,
    );
    await wait();
    for (const c of "rout") {
      app.stdin.write(c);
      await wait(20);
    }
    await wait();
    let screen = app.lastFrame() ?? "";
    expect(screen).toContain("OpenRouter");
    expect(screen).not.toContain("Codex");
    expect(screen).toContain("search: rout");
    app.stdin.write("\r");
    await wait();
    expect(chosen).toEqual(["openrouter"]);
    for (const c of "zz") {
      app.stdin.write(c);
      await wait(20);
    }
    await wait();
    expect(app.lastFrame()).toContain("No provider matches");
    app.stdin.write("\u001b");
    await wait();
    screen = app.lastFrame() ?? "";
    expect(screen).toContain("Codex");
    expect(matchesProvider({ id: "claude-code", name: "Claude (Claude Code)" }, "CLAUDE")).toBe(
      true,
    );
    app.unmount();
  });

  it("warns when Auto has no provider in it", async () => {
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude")]}
        onAuto={() => undefined}
        autoMembers={[]}
        onToggleAuto={() => undefined}
        onDone={() => undefined}
      />,
    );
    await wait();
    expect(app.lastFrame()).toContain("No provider is in Auto yet");
    app.unmount();
  });
});

describe("each provider's models in Auto", () => {
  it("m chooses them: Auto, or the ones marked with space", async () => {
    const codex: Provider = {
      ...fake("codex", "Codex"),
      models: () =>
        Promise.resolve([
          { id: "gpt-6-astra", name: "Astra 6" },
          { id: "gpt-6.1-sol", name: "Sol 6.1" },
        ]),
    };
    const saved: [string, string[]][] = [];
    const app = render(
      <ProviderPanel
        providers={[codex]}
        auto
        onAuto={() => undefined}
        autoMembers={["codex"]}
        onToggleAuto={() => undefined}
        autoModels={{}}
        onAutoModels={(id, models) => saved.push([id, models])}
        onDone={() => undefined}
      />,
    );
    await wait();
    expect(app.lastFrame()).toContain("models: auto");
    expect(app.lastFrame()).toContain("m its models");
    // Down to Codex (Auto is the first row), then m.
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write("m");
    await wait();
    expect(app.lastFrame()).toContain("Codex · models in Auto");
    expect(app.lastFrame()).toContain("[✓] Auto");
    // Down to Sol, mark it, save.
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write(" ");
    await wait();
    expect(app.lastFrame()).toContain("[✓] Sol 6.1");
    app.stdin.write("\r");
    await wait();
    expect(saved).toEqual([["codex", ["gpt-6.1-sol"]]]);
    expect(app.lastFrame()).toContain("Provider");
    app.unmount();
  });
});

describe("/connect: no model, and each provider's details", () => {
  it("each provider's status is folded until asked for: → one, tab all", async () => {
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude"), fake("codex", "Codex")]}
        onDone={() => undefined}
      />,
    );
    await wait();
    let screen = app.lastFrame() ?? "";
    expect(screen).toContain("Claude");
    expect(screen).toMatch(/Claude ✓/);
    expect(screen).not.toContain("Installed");
    expect(screen).not.toContain("Signed in");
    expect(screen).toContain("→ a provider's details");
    app.stdin.write("\u001B[C");
    await wait();
    screen = app.lastFrame() ?? "";
    // Only the selected one (Claude) opens.
    expect(screen.match(/Signed in/g)).toHaveLength(1);
    app.stdin.write("\u001B[D");
    await wait();
    expect(app.lastFrame()).not.toContain("Signed in");
    app.stdin.write("\t");
    await wait();
    expect((app.lastFrame() ?? "").match(/Signed in/g)).toHaveLength(2);
    app.unmount();
  });

  it("the first run shows each status: it is where what is installed is seen", async () => {
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude")]}
        firstRun
        onDone={() => undefined}
      />,
    );
    await wait();
    expect(app.lastFrame()).toContain("Signed in");
    app.unmount();
  });

  it("offers no model at all under Auto; enter chooses it", async () => {
    let none = 0;
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude")]}
        auto
        onAuto={() => undefined}
        onNone={() => {
          none++;
        }}
        onDone={() => undefined}
      />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen.indexOf("Auto · in use")).toBeLessThan(screen.indexOf("No model"));
    expect(screen.indexOf("No model")).toBeLessThan(screen.indexOf("Claude"));
    expect(screen).toContain("The chat uses none");
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write("\r");
    await wait();
    expect(none).toBe(1);
    app.unmount();
  });

  it("marks no model as in use when it is", async () => {
    const app = render(
      <ProviderPanel
        providers={[fake("claude-code", "Claude")]}
        none
        onNone={() => undefined}
        onDone={() => undefined}
      />,
    );
    await wait();
    expect(app.lastFrame()).toContain("▸ No model · in use");
    app.unmount();
  });
});
