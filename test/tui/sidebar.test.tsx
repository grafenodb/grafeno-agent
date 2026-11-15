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
