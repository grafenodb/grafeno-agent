import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  ConnectMenu,
  KeyEntry,
  sectionOf,
  type ConnectSection,
} from "../../src/tui/connect-menu.js";

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = "sk-secret-0123456789abcdef";

describe("/connect", () => {
  it("opens on six ways to connect, chosen by number, arrows or click", async () => {
    const chosen: ConnectSection[] = [];
    const app = render(
      <ConnectMenu onSection={(s) => chosen.push(s)} onCancel={() => undefined} />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    for (const label of [
      "1. CLI / Subscription",
      "2. API Key",
      "3. Coding Plan",
      "4. Local models / Self-hosted",
      "5. Manage connections",
      "6. View connections",
    ]) {
      expect(screen).toContain(label);
    }
    expect(screen).toContain("enter or click choose");
    app.stdin.write("3");
    await wait();
    app.stdin.write("5");
    await wait();
    app.stdin.write("4");
    await wait();
    expect(chosen).toEqual(["coding-plan", "manage", "local"]);
    app.unmount();
  });

  it("takes its sections as words: cli, api, plans, list, status, manage, disconnect", () => {
    expect(sectionOf("")).toBe("home");
    expect(sectionOf("add")).toBe("menu");
    expect(sectionOf("cli")).toBe("cli");
    expect(sectionOf("api")).toBe("api-key");
    expect(sectionOf("plans")).toBe("coding-plan");
    expect(sectionOf("list")).toBe("list");
    expect(sectionOf("status")).toBe("status");
    expect(sectionOf("manage")).toBe("manage");
    expect(sectionOf("local")).toBe("local");
    expect(sectionOf("ollama")).toBe("local");
    expect(sectionOf("disconnect deepseek")).toBe("disconnect");
    expect(sectionOf("nonsense")).toBeUndefined();
  });

  // Typed a character at a time, each frame looked at: slow when the whole suite runs at once.
  it(
    "never shows a key being typed, and checks it before keeping it",
    { timeout: 15_000 },
    async () => {
      const given: string[] = [];
      const frames: string[] = [];
      const app = render(
        <KeyEntry
          name="DeepSeek API"
          onSubmit={(key) => {
            given.push(key);
            return Promise.resolve({
              ok: true,
              message: "DeepSeek API accepted the key (2 models).",
            });
          }}
          onCancel={() => undefined}
        />,
      );
      await wait();
      for (const c of KEY) {
        app.stdin.write(c);
        await wait(5);
        frames.push(app.lastFrame() ?? "");
      }
      await wait();
      expect(app.lastFrame()).toContain("•".repeat(KEY.length));
      app.stdin.write("\r");
      await wait(100);
      expect(given).toEqual([KEY]);
      expect(app.lastFrame()).toContain("accepted the key");
      for (const frame of [...frames, ...app.frames]) expect(frame).not.toContain(KEY.slice(0, 8));
      app.unmount();
    },
  );
});
