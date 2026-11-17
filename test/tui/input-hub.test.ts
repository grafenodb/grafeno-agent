import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import {
  DOUBLE_CLICK_MS,
  InputHub,
  mouseReports,
  type Layer,
  type MouseEvent,
} from "../../src/tui/core/input.js";

const ESC = String.fromCharCode(27);
const NO_KEY = {} as Key;
const sgr = (code: number, x: number, y: number, end: "M" | "m" = "M") =>
  `${ESC}[<${String(code)};${String(x + 1)};${String(y + 1)}${end}`;

function handler(log: string[], name: string) {
  return { current: (input: string) => log.push(`${name}:${input}`) };
}

function entry(hub: InputHub, layer: Layer, log: string[], name: string, on = true) {
  const active = { current: on };
  const remove = hub.add({ layer, active, key: handler(log, name) });
  return { active, remove };
}

describe("one reader of the input, by layer", () => {
  it("a key goes to the highest layer on screen, then to the global shortcuts, told which", () => {
    const hub = new InputHub();
    const log: string[] = [];
    entry(hub, "base", log, "prompt");
    const menu = entry(hub, "overlay", log, "menu");
    hub.add({
      layer: "global",
      active: { current: true },
      global: { current: (input, _key, top) => log.push(`global:${input}:${String(top)}`) },
    });
    hub.key("x", NO_KEY);
    // The prompt behind the menu hears nothing.
    expect(log).toEqual(["menu:x", "global:x:overlay"]);
    log.length = 0;
    menu.remove();
    hub.key("y", NO_KEY);
    expect(log).toEqual(["prompt:y", "global:y:base"]);
  });

  it("an approval is over everything; a handler switched off leaves its layer", () => {
    const hub = new InputHub();
    const log: string[] = [];
    entry(hub, "base", log, "prompt");
    entry(hub, "overlay", log, "menu");
    const approval = entry(hub, "modal", log, "approval");
    hub.key("y", NO_KEY);
    expect(log).toEqual(["approval:y"]);
    log.length = 0;
    approval.active.current = false;
    hub.changed();
    expect(hub.top()).toBe("overlay");
    hub.key("n", NO_KEY);
    expect(log).toEqual(["menu:n"]);
  });

  it("within a layer every active handler hears the key (a panel and the menu in it)", () => {
    const hub = new InputHub();
    const log: string[] = [];
    entry(hub, "overlay", log, "panel");
    entry(hub, "overlay", log, "list");
    entry(hub, "overlay", log, "off", false);
    hub.key("a", NO_KEY);
    expect(log).toEqual(["panel:a", "list:a"]);
  });

  it("says when the layer with the focus changes", () => {
    const hub = new InputHub();
    const seen: (Layer | undefined)[] = [];
    hub.subscribe(() => seen.push(hub.snapshot()));
    const prompt = entry(hub, "base", [], "prompt");
    const menu = entry(hub, "overlay", [], "menu");
    menu.remove();
    prompt.remove();
    expect(seen).toEqual(["base", "overlay", "base", undefined]);
  });
});

describe("the mouse", () => {
  it("reads left, middle and right presses, releases and the wheel; drags are left out", () => {
    const chunk =
      sgr(0, 4, 2) +
      sgr(1, 4, 2) +
      sgr(2, 9, 3) +
      sgr(0, 9, 3, "m") +
      sgr(64, 1, 1) +
      sgr(65, 1, 1) +
      sgr(32, 5, 5);
    expect(mouseReports(chunk)).toEqual([
      { kind: "press", button: "left", x: 4, y: 2, double: false },
      { kind: "press", button: "middle", x: 4, y: 2, double: false },
      { kind: "press", button: "right", x: 9, y: 3, double: false },
      { kind: "release", x: 9, y: 3 },
      { kind: "wheel", direction: 1, x: 1, y: 1 },
      { kind: "wheel", direction: -1, x: 1, y: 1 },
    ]);
  });

  it("tells a double click: two left presses on the same cell, soon; not a third, a move or a wait", () => {
    let now = 1000;
    const hub = new InputHub(() => now);
    const events: MouseEvent[] = [];
    hub.add({
      layer: "global",
      active: { current: true },
      mouse: { current: (e) => events.push(e) },
    });
    const doubles = () => events.flatMap((e) => (e.kind === "press" ? [e.double] : []));
    hub.data(sgr(0, 3, 3));
    now += 150;
    hub.data(sgr(0, 3, 3));
    now += 150;
    hub.data(sgr(0, 3, 3));
    now += 100;
    hub.data(sgr(0, 8, 3));
    now += DOUBLE_CLICK_MS + 1;
    hub.data(sgr(0, 8, 3));
    expect(doubles()).toEqual([false, true, false, false, false]);
  });

  it("the wheel and the right button go to the layer with the focus; clicks reach the global ones", () => {
    const hub = new InputHub();
    const got: string[] = [];
    const on = (name: string) => ({ current: (e: MouseEvent) => got.push(`${name}:${e.kind}`) });
    hub.add({ layer: "base", active: { current: true }, mouse: on("chat") });
    hub.add({ layer: "overlay", active: { current: true }, mouse: on("menu") });
    hub.add({ layer: "global", active: { current: true }, mouse: on("clicks") });
    hub.data(sgr(64, 0, 0) + sgr(2, 1, 1));
    expect(got).toEqual(["menu:wheel", "clicks:wheel", "menu:press", "clicks:press"]);
  });
});
