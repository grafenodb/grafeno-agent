/**
 * Where each region of the interface goes, from what each needs: the
 * conversation first, then the side panel (usage, memory, the model), then
 * the agents panel (when a run started sub-agents). A region shows only
 * when it fits at least at its narrowest width beside the conversation at
 * its narrowest, so the breakpoints follow the content, not a number.
 *
 * - wide: the agents panel, the conversation and the side panel;
 * - standard: the conversation and one panel;
 * - compact: the conversation alone; the panels open over it (Ctrl+B).
 */

export type LayoutKind = "wide" | "standard" | "compact";

/** The narrowest each region can be, its usual width and the widest it may be made. */
export const REGION = {
  /** The conversation: a code line and its frame. */
  main: { min: 60 },
  /** The side panel: a usage meter with its label and percentage. */
  right: { min: 30, width: 38, max: 56 },
  /** The agents panel: an agent's name, state and model. */
  left: { min: 24, width: 30, max: 44 },
  /** Fewer rows than this: the conversation alone (a panel would be cut). */
  rows: 18,
} as const;

/** What the person chose for the panels (kept in the settings). */
export interface LayoutPrefs {
  readonly right: boolean;
  readonly left: boolean;
  readonly rightWidth: number;
  readonly leftWidth: number;
}

export const DEFAULT_PREFS: LayoutPrefs = {
  right: true,
  left: true,
  rightWidth: REGION.right.width,
  leftWidth: REGION.left.width,
};

export interface LayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly prefs: LayoutPrefs;
  /** Whether there is anything for the agents panel (sub-agents of a run). */
  readonly agents: boolean;
  /** The conversation maximized for now: the panels step aside. */
  readonly maximized?: boolean;
}

export interface Layout {
  readonly kind: LayoutKind;
  /** Each region's width in columns; 0: not shown. */
  readonly left: number;
  readonly main: number;
  readonly right: number;
  /** A panel the person wants that the window has no room for beside the conversation. */
  readonly hidden: readonly ("left" | "right")[];
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The regions' widths for a window. */
export function computeLayout(input: LayoutInput): Layout {
  const { columns, rows, prefs } = input;
  const wantRight = prefs.right;
  const wantLeft = prefs.left && input.agents;
  const wanted: ("left" | "right")[] = [
    ...(wantLeft ? (["left"] as const) : []),
    ...(wantRight ? (["right"] as const) : []),
  ];
  if (input.maximized === true || rows < REGION.rows) {
    return { kind: "compact", left: 0, main: columns, right: 0, hidden: wanted };
  }
  // The room beside the conversation at its narrowest: the side panel first, then the agents'.
  const free = columns - REGION.main.min;
  let right = 0;
  let left = 0;
  if (wantRight && free >= REGION.right.min) {
    // As wide as chosen, narrower when the window is: never under its narrowest.
    right = clamp(Math.min(prefs.rightWidth, free), REGION.right.min, REGION.right.max);
  }
  if (wantLeft && free - right >= REGION.left.min) {
    left = clamp(Math.min(prefs.leftWidth, free - right), REGION.left.min, REGION.left.max);
  }
  const shown = (right > 0 ? 1 : 0) + (left > 0 ? 1 : 0);
  return {
    kind: shown === 2 ? "wide" : shown === 1 ? "standard" : "compact",
    left,
    main: columns - left - right,
    right,
    hidden: wanted.filter((side) => (side === "left" ? left : right) === 0),
  };
}

/** The panels' preferences from their setting ("right=off,rightWidth=44"); defaults otherwise. */
export function parseLayoutPrefs(setting: string | undefined): LayoutPrefs {
  const prefs: { -readonly [K in keyof LayoutPrefs]: LayoutPrefs[K] } = { ...DEFAULT_PREFS };
  for (const pair of (setting ?? "").split(",")) {
    const [name, value] = pair.split("=").map((p) => p.trim());
    if (!name || value === undefined) continue;
    if (name === "right" || name === "left") prefs[name] = !/^(off|false|0|no)$/i.test(value);
    else if (name === "rightWidth" || name === "leftWidth") {
      const n = Number(value);
      const region = name === "rightWidth" ? REGION.right : REGION.left;
      if (Number.isFinite(n)) prefs[name] = clamp(Math.round(n), region.min, region.max);
    }
  }
  return prefs;
}

/** The panels' preferences as their setting: only what differs from the defaults. */
export function layoutSetting(prefs: LayoutPrefs): string {
  const parts: string[] = [];
  if (!prefs.right) parts.push("right=off");
  if (!prefs.left) parts.push("left=off");
  if (prefs.rightWidth !== DEFAULT_PREFS.rightWidth)
    parts.push(`rightWidth=${String(prefs.rightWidth)}`);
  if (prefs.leftWidth !== DEFAULT_PREFS.leftWidth)
    parts.push(`leftWidth=${String(prefs.leftWidth)}`);
  return parts.join(",");
}

/** A panel made wider or narrower by a step, within its limits. */
export function resized(prefs: LayoutPrefs, side: "left" | "right", by: number): LayoutPrefs {
  const region = side === "right" ? REGION.right : REGION.left;
  const key = side === "right" ? "rightWidth" : "leftWidth";
  return { ...prefs, [key]: clamp(prefs[key] + by, region.min, region.max) };
}
