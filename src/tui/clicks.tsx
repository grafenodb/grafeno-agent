import { Box, useStdin, type BoxProps, type DOMElement } from "ink";
import { useInputHub, useMouse } from "./core/input.js";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

const ESC = String.fromCharCode(27);

/** An SGR mouse report: ESC [ < button ; column ; row M (press) or m (release). */
const REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

/** A left click, in cells from the top-left corner of the screen (0-based). */
export interface Click {
  readonly x: number;
  readonly y: number;
}

/**
 * The left clicks in a chunk of input: presses of the left button, without
 * the wheel, drags or the other buttons.
 */
export function clicksIn(chunk: string): Click[] {
  const clicks: Click[] = [];
  for (const match of chunk.matchAll(REPORT)) {
    const button = Number(match[1]);
    // Bits: 0–1 the button, 32 a move while pressed, 64 the wheel.
    if (match[4] !== "M" || (button & 3) !== 0 || (button & 96) !== 0) continue;
    clicks.push({ x: Number(match[2]) - 1, y: Number(match[3]) - 1 });
  }
  return clicks;
}

interface Region {
  readonly ref: RefObject<DOMElement | null>;
  readonly onClick: RefObject<() => void>;
  readonly onDoubleClick?: RefObject<(() => void) | undefined>;
  readonly onRightClick?: RefObject<(() => void) | undefined>;
}

/** What a click was: the left button once or twice, or the right one. */
export type ClickKind = "left" | "double" | "right";

/** The clickable regions on screen now. */
class ClickRegistry {
  readonly #regions = new Set<Region>();

  add(region: Region): () => void {
    this.#regions.add(region);
    return () => {
      this.#regions.delete(region);
    };
  }

  /**
   * Clicks the smallest region under a point (the innermost one) that
   * answers this kind of click: a double click is a click to a region
   * without its own; false when none is there.
   */
  click(point: Click, kind: ClickKind = "left"): boolean {
    const answers = (region: Region) =>
      kind === "right" ? region.onRightClick?.current !== undefined : true;
    let best: { region: Region; area: number } | undefined;
    for (const region of this.#regions) {
      const box = region.ref.current ? rectOf(region.ref.current) : undefined;
      if (!box) continue;
      const inside =
        point.x >= box.x &&
        point.x < box.x + box.width &&
        point.y >= box.y &&
        point.y < box.y + box.height;
      const area = box.width * box.height;
      if (inside && answers(region) && (!best || area < best.area)) best = { region, area };
    }
    if (!best) return false;
    const { region } = best;
    if (kind === "right") region.onRightClick?.current?.();
    else if (kind === "double" && region.onDoubleClick?.current) region.onDoubleClick.current();
    else region.onClick.current();
    return true;
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a node is laid out, before any scrolling: its layout added to its ancestors'. */
function laidOut(node: DOMElement): Rect | undefined {
  const own = node.yogaNode?.getComputedLayout();
  if (!own) return undefined;
  let x = 0;
  let y = 0;
  for (let at: DOMElement | undefined = node; at; at = at.parentNode) {
    const layout = at.yogaNode?.getComputedLayout();
    if (layout) {
      x += layout.left;
      y += layout.top;
    }
  }
  return { x, y, width: own.width, height: own.height };
}

const offsetOf = (value: unknown) => (typeof value === "number" ? value : 0);

/**
 * Where an element is on the screen: its layout, moved by the containers
 * scrolled around it (`contentOffsetX`/`contentOffsetY`), and cut to what
 * the containers that hide their overflow show. Nothing when none of it shows.
 */
export function rectOf(node: DOMElement): Rect | undefined {
  const rect = laidOut(node);
  if (!rect) return undefined;
  let { x, y } = rect;
  let right = x + rect.width;
  let bottom = y + rect.height;
  for (let at = node.parentNode; at; at = at.parentNode) {
    const dx = offsetOf(at.style.contentOffsetX);
    const dy = offsetOf(at.style.contentOffsetY);
    x -= dx;
    right -= dx;
    y -= dy;
    bottom -= dy;
    if (at.style.overflow === "hidden" || at.style.overflowY === "hidden") {
      const view = laidOut(at);
      if (view) {
        // The container's own place, moved by the containers scrolled around it.
        let vy = view.y;
        let vx = view.x;
        for (let up = at.parentNode; up; up = up.parentNode) {
          vx -= offsetOf(up.style.contentOffsetX);
          vy -= offsetOf(up.style.contentOffsetY);
        }
        x = Math.max(x, vx);
        y = Math.max(y, vy);
        right = Math.min(right, vx + view.width);
        bottom = Math.min(bottom, vy + view.height);
      }
    }
  }
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

const ClickContext = createContext<ClickRegistry | undefined>(undefined);

/**
 * Makes what is inside clickable with the mouse: reads the terminal's
 * mouse reports (turned on by the interface) and gives each left click to
 * the `Clickable` under it. Keys go on working as before: every click has a
 * key or a command that does the same.
 */
export function ClickArea({
  children,
  active = true,
}: {
  readonly children: ReactNode;
  /** Off while something must not be clicked through (nothing, today). */
  readonly active?: boolean;
}): ReactNode {
  const registry = useMemo(() => new ClickRegistry(), []);
  const { stdin } = useStdin();
  const hub = useInputHub();
  // In the interface's input area, clicks come from its one reader of the terminal.
  useMouse(
    (event) => {
      if (event.kind !== "press") return;
      if (event.button === "left") registry.click(event, event.double ? "double" : "left");
      else if (event.button === "right") registry.click(event, "right");
    },
    { layer: "global", isActive: active && hub !== undefined },
  );
  useEffect(() => {
    if (!active || hub) return;
    const listener = (chunk: Buffer | string) => {
      for (const click of clicksIn(chunk.toString())) registry.click(click);
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin, registry, active, hub]);
  return <ClickContext value={registry}>{children}</ClickContext>;
}

/**
 * A box that does something when clicked. Outside a `ClickArea` (or with
 * no `onClick`) it is a plain box.
 */
export function Clickable({
  onClick,
  onDoubleClick,
  onRightClick,
  children,
  ...box
}: BoxProps & {
  readonly onClick?: (() => void) | undefined;
  /** Two clicks on the same place (an inspector); without it, a double click is a click. */
  readonly onDoubleClick?: (() => void) | undefined;
  /** The right button (a context menu; Shift+F10 does the same from the keyboard). */
  readonly onRightClick?: (() => void) | undefined;
  readonly children?: ReactNode;
}): ReactNode {
  const registry = use(ClickContext);
  const ref = useRef<DOMElement | null>(null);
  const handler = useRef<() => void>(() => undefined);
  handler.current = onClick ?? (() => undefined);
  const double = useRef(onDoubleClick);
  double.current = onDoubleClick;
  const right = useRef(onRightClick);
  right.current = onRightClick;
  const enabled =
    onClick !== undefined || onDoubleClick !== undefined || onRightClick !== undefined;
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.add({ ref, onClick: handler, onDoubleClick: double, onRightClick: right });
  }, [registry, enabled]);
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}
