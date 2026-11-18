import { useInput, useStdin, type Key } from "ink";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * The interface's input, read in one place: every key and every mouse
 * report goes to whoever has the focus, never to everyone.
 *
 * What is on screen takes keys by layer: an approval (`modal`) over a menu
 * or dialog (`overlay`) over the conversation (`base`). A key goes to the
 * active handlers of the highest layer that has any, then to the global
 * shortcuts, which are told which layer had it (so Esc closes a menu
 * instead of stopping the agent, and a key typed in a menu never reaches
 * the conversation's prompt behind it). The layers below get nothing.
 *
 * Within a layer every active handler hears the key, as before: a menu and
 * the panel it is part of share it. A menu that opens over another one is
 * the only one active (each gates itself), so the one under it waits.
 */

export type Layer = "modal" | "overlay" | "base";

const RANK: Readonly<Record<Layer, number>> = { modal: 3, overlay: 2, base: 1 };

export type KeyHandler = (input: string, key: Key) => void;
/** A global shortcut: told which layer had the key (none: nothing has the focus). */
export type GlobalHandler = (input: string, key: Key, top: Layer | undefined) => void;

export type MouseButton = "left" | "middle" | "right";

/** What the mouse did, in cells from the top-left corner of the screen (0-based). */
export type MouseEvent =
  | {
      readonly kind: "press";
      readonly button: MouseButton;
      readonly x: number;
      readonly y: number;
      /** A second left press on the same cell soon after the first. */
      readonly double: boolean;
    }
  | { readonly kind: "release"; readonly x: number; readonly y: number }
  | { readonly kind: "wheel"; readonly direction: 1 | -1; readonly x: number; readonly y: number };

const ESC = String.fromCharCode(27);
/** An SGR mouse report: ESC [ < button ; column ; row M (press) or m (release). */
const REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");
const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];

/** Shift+F10 (ESC [ 21 ; 2 ~) and the Menu key (ESC [ 29 ~): the keyboard's right click. */
const MENU_KEY = new RegExp(`${ESC}\\[(?:21;2|29)~`, "g");

/** How many times a chunk of input asks for a context menu. */
export function menuKeys(chunk: string): number {
  return [...chunk.matchAll(MENU_KEY)].length;
}

/** Two left presses on the same cell within this many ms are a double click. */
export const DOUBLE_CLICK_MS = 400;

/**
 * The mouse reports in a chunk of input, without double clicks (the hub
 * tells those, since they span chunks). Moves while a button is held
 * (drags) are left out: the interface does not ask for them yet.
 */
export function mouseReports(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of chunk.matchAll(REPORT)) {
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    // Bits: 0–1 the button, 32 a move while pressed, 64 the wheel.
    if ((code & 64) !== 0) {
      events.push({ kind: "wheel", direction: (code & 1) === 0 ? 1 : -1, x, y });
      continue;
    }
    if ((code & 32) !== 0) continue;
    if (match[4] === "m") {
      events.push({ kind: "release", x, y });
      continue;
    }
    const button = BUTTONS[code & 3];
    if (button) events.push({ kind: "press", button, x, y, double: false });
  }
  return events;
}

interface Entry {
  readonly layer: Layer | "global";
  readonly active: { current: boolean };
  readonly key?: { current: KeyHandler };
  readonly global?: { current: GlobalHandler };
  readonly wheel?: { current: (direction: number) => void };
  readonly mouse?: { current: (event: MouseEvent) => void };
  readonly menu?: { current: () => void };
}

/** Who takes input now: the handlers on screen, by layer. */
export class InputHub {
  readonly #entries = new Set<Entry>();
  readonly #listeners = new Set<() => void>();
  #lastPress: { x: number; y: number; at: number } | undefined;
  #top: Layer | undefined;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(entry: Entry): () => void {
    this.#entries.add(entry);
    this.changed();
    return () => {
      this.#entries.delete(entry);
      this.changed();
    };
  }

  /** The highest layer with an active handler. */
  top(): Layer | undefined {
    let best: Layer | undefined;
    for (const entry of this.#entries) {
      if (entry.layer === "global" || !entry.active.current) continue;
      if (!best || RANK[entry.layer] > RANK[best]) best = entry.layer;
    }
    return best;
  }

  /** Something registered, left, or switched itself on or off: the top layer may be another. */
  changed(): void {
    const top = this.top();
    if (top === this.#top) return;
    this.#top = top;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): Layer | undefined => this.#top;

  key(input: string, key: Key): void {
    const top = this.top();
    // A snapshot: a handler may open or close something as it runs.
    const entries = [...this.#entries];
    if (top) {
      for (const entry of entries) {
        if (entry.layer === top && entry.active.current) entry.key?.current(input, key);
      }
    }
    for (const entry of entries) {
      if (entry.layer === "global" && entry.active.current) entry.global?.current(input, key, top);
    }
  }

  /** A chunk of the terminal's input: its mouse reports go where the focus is. */
  data(chunk: string): void {
    for (const report of mouseReports(chunk)) this.mouse(report);
    // Ink hands Shift+F10 over as an empty key and drops the Menu key: read here.
    for (let i = 0; i < menuKeys(chunk); i++) this.menuKey();
  }

  /** Shift+F10 or the Menu key: the actions of what is selected, in the layer with the focus. */
  menuKey(): void {
    const top = this.top();
    for (const entry of [...this.#entries]) {
      if (entry.layer === top && entry.active.current) entry.menu?.current();
    }
  }

  mouse(report: MouseEvent): void {
    let event = report;
    if (report.kind === "press" && report.button === "left") {
      const now = this.#now();
      const last = this.#lastPress;
      const double =
        last !== undefined &&
        last.x === report.x &&
        last.y === report.y &&
        now - last.at <= DOUBLE_CLICK_MS;
      // A third press starts again: a double click is two, not three.
      this.#lastPress = double ? undefined : { x: report.x, y: report.y, at: now };
      event = { ...report, double };
    }
    const top = this.top();
    for (const entry of [...this.#entries]) {
      // Clicks reach every clickable thing (the click registry finds the one under the
      // pointer); the wheel and the other buttons go to the layer that has the focus.
      const reaches = entry.layer === "global" || entry.layer === top;
      if (!reaches || !entry.active.current) continue;
      if (event.kind === "wheel") entry.wheel?.current(event.direction);
      entry.mouse?.current(event);
    }
  }
}

const HubContext = createContext<InputHub | undefined>(undefined);

/** The hub of the interface around this component; none outside an `InputArea`. */
export function useInputHub(): InputHub | undefined {
  return use(HubContext);
}

/**
 * Reads the interface's input in one place: Ink's keys and the terminal's
 * mouse reports, each given to whoever has the focus.
 */
export function InputArea({
  children,
  hub: given,
  active = true,
}: {
  readonly children: ReactNode;
  /** A hub of one's own (tests); default: a new one. */
  readonly hub?: InputHub;
  /** False: nothing reaches it (a tab that is not on screen). */
  readonly active?: boolean;
}): ReactNode {
  const hub = useMemo(() => given ?? new InputHub(), [given]);
  const { stdin } = useStdin();
  useInput(
    (input, key) => {
      hub.key(input, key);
    },
    { isActive: active },
  );
  useEffect(() => {
    if (!active) return;
    const listener = (chunk: Buffer | string) => {
      hub.data(chunk.toString());
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin, hub, active]);
  return <HubContext value={hub}>{children}</HubContext>;
}

function useEntry(
  hub: InputHub | undefined,
  layer: Layer | "global",
  isActive: boolean,
  parts: Omit<Entry, "layer" | "active">,
): void {
  const active = useRef(isActive);
  active.current = isActive;
  // Registered once; the handlers and the switch are read through refs. In the
  // same commit that draws it (a layout effect): a passive effect can run after
  // the next key, and a list that just appeared would miss the Enter pressed on it.
  useLayoutEffect(() => {
    if (!hub) return;
    return hub.add({ layer, active, ...parts });
  }, [hub, layer]);
  useLayoutEffect(() => {
    hub?.changed();
  }, [hub, isActive]);
}

/**
 * Keys for a component in a layer: in an `InputArea`, it hears them only
 * while its layer is the highest on screen; outside one (a component on
 * its own, in a test), it hears every key, as Ink's `useInput` does.
 */
export function useKeys(
  handler: KeyHandler,
  options: { readonly layer?: Layer; readonly isActive?: boolean } = {},
): void {
  const hub = useInputHub();
  const ref = useRef(handler);
  ref.current = handler;
  const isActive = options.isActive ?? true;
  useEntry(hub, options.layer ?? "overlay", isActive, { key: ref });
  useInput(
    (input, key) => {
      ref.current(input, key);
    },
    { isActive: !hub && isActive },
  );
}

/** The global shortcuts: they hear every key after the layer that had it, told which one. */
export function useGlobalKeys(handler: GlobalHandler, isActive = true): void {
  const hub = useInputHub();
  const ref = useRef(handler);
  ref.current = handler;
  useEntry(hub, "global", isActive, { global: ref });
  useInput(
    (input, key) => {
      ref.current(input, key, undefined);
    },
    { isActive: !hub && isActive },
  );
}

/** The layer that has the focus now (none outside an `InputArea`, or when nothing takes keys). */
export function useFocusLayer(): Layer | undefined {
  const hub = useInputHub();
  return useSyncExternalStore(
    hub?.subscribe ?? noSubscribe,
    hub?.snapshot ?? noTop,
    hub?.snapshot ?? noTop,
  );
}

/** Whether a layer is the one that has the focus now (true outside an `InputArea`). */
export function useHasFocus(layer: Layer, isActive = true): boolean {
  const hub = useInputHub();
  const top = useSyncExternalStore(
    hub?.subscribe ?? noSubscribe,
    hub?.snapshot ?? noTop,
    hub?.snapshot ?? noTop,
  );
  return isActive && (!hub || top === layer);
}

/**
 * The mouse for a component in a layer: the wheel and the other buttons
 * reach it while its layer has the focus. Outside an `InputArea` it reads
 * the terminal itself.
 */
export function useMouse(
  handler: (event: MouseEvent) => void,
  options: { readonly layer?: Layer | "global"; readonly isActive?: boolean } = {},
): void {
  const hub = useInputHub();
  const ref = useRef(handler);
  ref.current = handler;
  const isActive = options.isActive ?? true;
  useEntry(hub, options.layer ?? "overlay", isActive, { mouse: ref });
  const { stdin } = useStdin();
  useEffect(() => {
    if (hub || !isActive) return;
    const listener = (chunk: Buffer | string) => {
      for (const event of mouseReports(chunk.toString())) ref.current(event);
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [hub, isActive, stdin]);
}

const noSubscribe = () => () => undefined;
const noTop = () => undefined;

/**
 * Shift+F10 or the Menu key for a component in a layer: what a right click
 * does, from the keyboard. Only in an `InputArea` (it reads the terminal).
 */
export function useMenuKey(
  handler: () => void,
  options: { readonly layer?: Layer; readonly isActive?: boolean } = {},
): void {
  const hub = useInputHub();
  const ref = useRef(handler);
  ref.current = handler;
  useEntry(hub, options.layer ?? "overlay", options.isActive ?? true, { menu: ref });
}
