import { describe, expect, it } from "vitest";
import { copyToClipboard, osc52 } from "../../src/tui/clipboard.js";
import {
  f6Presses,
  holdMouse,
  mouseHeld,
  MOUSE_OFF,
  MOUSE_ON,
  toggleMouse,
} from "../../src/tui/mouse.js";

const ESC = String.fromCharCode(27);

describe("F6 and the mouse", () => {
  it("reads F6, alone or with modifiers, and nothing else", () => {
    expect(f6Presses(`${ESC}[17~`)).toBe(1);
    expect(f6Presses(`${ESC}[17;2~${ESC}[17~`)).toBe(2);
    expect(f6Presses(`${ESC}[18~ hello ${ESC}[21;2~`)).toBe(0);
  });

  it("is a no-op until the interface holds the mouse, then F6 releases it and takes it back", () => {
    expect(toggleMouse()).toBeUndefined();
    const written: string[] = [];
    holdMouse((data) => written.push(data));
    expect(mouseHeld()).toBe(true);
    expect(toggleMouse()).toBe(false);
    expect(toggleMouse()).toBe(true);
    expect(written).toEqual([MOUSE_OFF, MOUSE_ON]);
  });
});

describe("the clipboard", () => {
  it("uses the platform's copy command, with the text in UTF-8", async () => {
    const calls: [string, readonly string[], string][] = [];
    const way = await copyToClipboard("héllo ✓", {
      platform: "linux",
      runner: (command, args, text) => {
        calls.push([command, args, text]);
        return Promise.resolve(command === "xclip");
      },
      write: () => {
        throw new Error("not the terminal");
      },
    });
    expect(way).toBe("system");
    expect(calls.map((c) => c[0])).toEqual(["wl-copy", "xclip"]);
    expect(calls[1]?.[2]).toBe("héllo ✓");
  });

  it("asks the terminal itself (OSC 52) when no copy command works", async () => {
    const written: string[] = [];
    const way = await copyToClipboard("hola", {
      platform: "win32",
      runner: () => Promise.resolve(false),
      write: (data) => written.push(data),
    });
    expect(way).toBe("terminal");
    expect(written).toEqual([osc52("hola")]);
    expect(osc52("hola")).toContain(Buffer.from("hola").toString("base64"));
  });
});
