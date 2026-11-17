import { describe, expect, it } from "vitest";
import {
  computeLayout,
  DEFAULT_PREFS,
  layoutSetting,
  parseLayoutPrefs,
  REGION,
  resized,
} from "../../src/tui/core/layout.js";

const at = (columns: number, extra: Partial<Parameters<typeof computeLayout>[0]> = {}) =>
  computeLayout({ columns, rows: 40, prefs: DEFAULT_PREFS, agents: false, ...extra });

describe("the layout follows what each region needs", () => {
  it("the side panel shows once it fits beside the conversation at its narrowest", () => {
    // 60 for the conversation, 30 at least for the panel.
    expect(at(89)).toMatchObject({ kind: "compact", right: 0, main: 89, hidden: ["right"] });
    expect(at(90)).toMatchObject({ kind: "standard", right: 30, main: 60 });
    // Its chosen width once there is room for it.
    expect(at(120)).toMatchObject({ kind: "standard", right: 38, main: 82 });
  });

  it("wide: the agents panel too, when there are sub-agents and room for all three", () => {
    expect(at(150, { agents: true })).toMatchObject({
      kind: "wide",
      left: 30,
      right: 38,
      main: 82,
    });
    // Not enough for both: the side panel stays, the agents panel waits (Ctrl+N and /agents work).
    expect(at(110, { agents: true })).toMatchObject({
      kind: "standard",
      left: 0,
      right: 38,
      hidden: ["left"],
    });
    // No sub-agents: no agents panel, whatever the room.
    expect(at(200).left).toBe(0);
  });

  it("the conversation always keeps its narrowest width; the panels never go under theirs", () => {
    for (let columns = 40; columns <= 220; columns += 3) {
      const layout = at(columns, { agents: true });
      expect(layout.main).toBeGreaterThanOrEqual(Math.min(columns, REGION.main.min));
      expect(layout.left + layout.main + layout.right).toBe(columns);
      if (layout.right > 0) expect(layout.right).toBeGreaterThanOrEqual(REGION.right.min);
      if (layout.left > 0) expect(layout.left).toBeGreaterThanOrEqual(REGION.left.min);
    }
  });

  it("panels switched off, a short window, or the conversation maximized: the conversation alone", () => {
    expect(at(150, { prefs: { ...DEFAULT_PREFS, right: false } })).toMatchObject({
      kind: "compact",
      right: 0,
      hidden: [],
    });
    expect(at(150, { rows: 12 })).toMatchObject({ kind: "compact", right: 0 });
    expect(at(200, { agents: true, maximized: true })).toMatchObject({
      kind: "compact",
      left: 0,
      right: 0,
      main: 200,
      hidden: ["left", "right"],
    });
  });
});

describe("the panels' preferences", () => {
  it("are read from their setting, within limits, and written back with only what differs", () => {
    expect(parseLayoutPrefs(undefined)).toEqual(DEFAULT_PREFS);
    const prefs = parseLayoutPrefs("right=off, rightWidth=99, leftWidth=26, nonsense");
    expect(prefs).toEqual({
      right: false,
      left: true,
      rightWidth: REGION.right.max,
      leftWidth: 26,
    });
    expect(layoutSetting(prefs)).toBe(
      `right=off,rightWidth=${String(REGION.right.max)},leftWidth=26`,
    );
    expect(layoutSetting(DEFAULT_PREFS)).toBe("");
  });

  it("a panel is resized a step at a time, never past its limits", () => {
    expect(resized(DEFAULT_PREFS, "right", 4).rightWidth).toBe(42);
    expect(resized(DEFAULT_PREFS, "right", -100).rightWidth).toBe(REGION.right.min);
    expect(resized(DEFAULT_PREFS, "left", 100).leftWidth).toBe(REGION.left.max);
  });
});
