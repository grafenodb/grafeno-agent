import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { probeGrafeno, type AppServices } from "../../src/app/services.js";
import { PalacePanel } from "../../src/tui/palace.js";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function services(local: { url: string; version: string } | undefined): AppServices {
  return {
    settingsPath: "config.env",
    grafeno: () => ({
      mode: "external",
      url: "http://127.0.0.1:7810",
      namespace: "grafeno-agent",
      hasKey: false,
      includable: true,
      installed: false,
    }),
    findLocalGrafeno: () => Promise.resolve(local),
  } as unknown as AppServices;
}

describe("where the memory lives", () => {
  it("offers the Grafeno found on this computer beside the agent's own, which leaves it untouched", async () => {
    const app = render(
      <PalacePanel
        services={services({ url: "http://127.0.0.1:7810", version: "0.3.0" })}
        firstRun
        onDone={() => undefined}
      />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("The agent's own Grafeno");
    expect(screen).toContain("your Grafeno at http://127.0.0.1:7810 stays untouched");
    expect(screen).toContain("The Grafeno on this computer");
    expect(screen).toContain("Grafeno 0.3.0 at http://127.0.0.1:7810");
    expect(screen).toContain("Another Grafeno server");
    app.unmount();
  });

  it("offers the agent's own, or a server, when none answers on this computer", async () => {
    const app = render(
      <PalacePanel services={services(undefined)} firstRun onDone={() => undefined} />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("The agent's own Grafeno");
    expect(screen).not.toContain("The Grafeno on this computer");
    expect(screen).toContain("none answers on this computer");
    app.unmount();
  });

  it("finds a Grafeno by its /health, and nothing where none answers", async () => {
    const answering = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok", version: "0.3.0" })),
      )) as typeof fetch;
    expect(await probeGrafeno("http://127.0.0.1:7810/", answering)).toEqual({
      url: "http://127.0.0.1:7810/",
      version: "0.3.0",
    });
    const refusing = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    expect(await probeGrafeno("http://127.0.0.1:7810", refusing)).toBeUndefined();
  });
});
