import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../src/tui/sidebar.js";

const grafeno = {
  mode: "external" as const,
  url: "http://grafeno.test:7810",
  namespace: "test",
  hasKey: true,
  includable: true,
  installed: false,
};

describe("the side panel in Auto", () => {
  it("shows each of Auto's providers with its usage, an API key's credits, or why there is none", () => {
    const at = new Date();
    const app = render(
      <Sidebar
        width={38}
        session={undefined}
        grafeno={grafeno}
        status={undefined}
        usage={undefined}
        models={[]}
        environment={{}}
        autoUsage={[
          {
            id: "claude-code",
            name: "Claude (Claude Code)",
            apiKey: false,
            current: true,
            usage: { limits: [{ label: "Session", used: 0.32 }], at },
          },
          {
            id: "openrouter",
            name: "OpenRouter (API key)",
            apiKey: true,
            current: false,
            usage: { limits: [{ label: "Free requests today", used: 0.24 }], at },
          },
          { id: "gemini", name: "Gemini (AI Studio)", apiKey: true, current: false },
        ]}
      />,
    );
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("USAGE · AUTO");
    expect(screen).toContain("Claude (Claude Code)");
    expect(screen).toMatch(/Session\s+32%/);
    expect(screen).toMatch(/Free requests today\s+24%/);
    expect(screen).toContain("its API does not report usage");
    // In Auto, the per-provider list replaces the single plan's usage.
    expect(screen).not.toContain("PLAN USAGE");
    app.unmount();
  });
});

describe("the side panel's plan usage", () => {
  it("says when the latest reading failed and the one shown is older", () => {
    const at = new Date(Date.now() - 23 * 60_000);
    const app = render(
      <Sidebar
        width={38}
        session={undefined}
        grafeno={grafeno}
        status={undefined}
        usage={{ limits: [{ label: "Session", used: 0.4 }], at }}
        usageStale
        models={[]}
        environment={{}}
      />,
    );
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("23 min ago");
    expect(screen).toContain("The latest reading failed");
    app.unmount();
  });

  it("marks one of Auto's providers whose latest reading failed", () => {
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
            id: "codex",
            name: "Codex",
            apiKey: false,
            current: false,
            stale: true,
            usage: { limits: [{ label: "5 h", used: 0.2 }], at: new Date(Date.now() - 5 * 60_000) },
          },
        ]}
      />,
    );
    expect(app.lastFrame()).toMatch(/Codex · 5 min ago · old/);
    app.unmount();
  });
});

describe("the side panel on a sub-agent", () => {
  it("shows that sub-agent's own task, model, tokens, context and where it works", () => {
    const app = render(
      <Sidebar
        width={44}
        session={undefined}
        grafeno={grafeno}
        status={undefined}
        usage={undefined}
        models={[]}
        environment={{}}
        agent={{
          id: "implementar-api",
          runId: "run-x",
          title: "Implement the API",
          state: "running",
          doing: "edit_file src/api.py",
          lines: [],
          model: "codex/gpt-6.1-sol",
          effort: "medium",
          tier: "standard",
          started: new Date(Date.now() - 120_000),
          tokens: { input: 12_000, output: 3_400, cache: 40_000 },
          context: { used: 50_000, window: 200_000 },
          folder: "C:/data/worktrees/sdk/fecdf218/implementar-api",
          branch: "grafeno/fecdf218/implementar-api",
          lastReport: "Transport done; starting the API",
        }}
      />,
    );
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("SUB-AGENT");
    expect(screen).toContain("implementar-api");
    expect(screen).toContain("codex/gpt-6.1-sol");
    expect(screen).toContain("standard · medium");
    expect(screen).toContain("52.0k in · 3.4k out");
    expect(screen).toMatch(/50\.0k \/ 200\.0k\s+25%/);
    expect(screen).toContain("grafeno/fecdf218/implementar-api");
    expect(screen).toContain("Transport done; starting the API");
    // The main agent's own sections give way to the sub-agent's.
    expect(screen).not.toContain("PLAN USAGE");
    app.unmount();
  });
});
