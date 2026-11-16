import { Box, useStdin, type BoxProps, type DOMElement } from "ink";
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
}

/** The clickable regions on screen now. */
class ClickRegistry {
  readonly #regions = new Set<Region>();

  add(region: Region): () => void {
    this.#regions.add(region);
    return () => {
      this.#regions.delete(region);
    };
  }

  /** Clicks the smallest region under a point (the innermost one); false when none is there. */
  click(point: Click): boolean {
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
      if (inside && (!best || area < best.area)) best = { region, area };
    }
    if (!best) return false;
    best.region.onClick.current();
    return true;
  }
}

/** Where an element is on the screen: its layout added to its ancestors'. */
export function rectOf(
  node: DOMElement,
): { x: number; y: number; width: number; height: number } | undefined {
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
  useEffect(() => {
    if (!active) return;
    const listener = (chunk: Buffer | string) => {
      for (const click of clicksIn(chunk.toString())) registry.click(click);
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin, registry, active]);
  return <ClickContext value={registry}>{children}</ClickContext>;
}

/**
 * A box that does something when clicked. Outside a `ClickArea` (or with
 * no `onClick`) it is a plain box.
 */
export function Clickable({
  onClick,
  children,
  ...box
}: BoxProps & {
  readonly onClick?: (() => void) | undefined;
  readonly children?: ReactNode;
}): ReactNode {
  const registry = use(ClickContext);
  const ref = useRef<DOMElement | null>(null);
  const handler = useRef<() => void>(() => undefined);
  handler.current = onClick ?? (() => undefined);
  const enabled = onClick !== undefined;
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.add({ ref, onClick: handler });
  }, [registry, enabled]);
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}
