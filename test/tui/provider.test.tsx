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
