import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FakeModel } from "../../src/model/index.js";
import type { Provider } from "../../src/providers/types.js";
import { ProviderPanel } from "../../src/tui/provider.js";

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
    // Down to OpenRouter, then space: it is offered to Auto.
    app.stdin.write("\u001B[B");
    await wait();
    app.stdin.write(" ");
    await wait();
    expect(toggled).toEqual(["openrouter"]);
    app.unmount();
  });
});
