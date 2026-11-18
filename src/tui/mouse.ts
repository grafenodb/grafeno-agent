import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { useInputHub, useMouse, type Layer } from "./core/input.js";

const ESC = String.fromCharCode(27);

/** Turns on the terminal's mouse reports (SGR): the wheel comes as events, not as arrow keys. */
export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
export const MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;

/** An SGR mouse report: ESC [ < button ; column ; row M (or m on release). */
const REPORT = new RegExp(`${ESC}\\[<(\\d+);\\d+;\\d+[Mm]`, "g");

/** The wheel turns in a chunk of input: +1 up, -1 down, for each notch. */
export function wheelTurns(chunk: string): number[] {
  const turns: number[] = [];
  for (const match of chunk.matchAll(REPORT)) {
    const button = Number(match[1]);
    // Wheel buttons have bit 64; bit 1 tells down from up.
    if ((button & 64) !== 0) turns.push((button & 1) === 0 ? 1 : -1);
  }
  return turns;
}

/**
 * Calls `onWheel` with +1 (up) or -1 (down) for each notch of the mouse
 * wheel. In the interface's input area it turns only while `layer` has the
 * focus (the conversation does not scroll behind an open menu); outside
 * one, it reads the terminal itself. Ink reads the same input and drops the
 * mouse reports, so typing is never disturbed.
 */
export function useWheel(onWheel: (direction: number) => void, layer: Layer = "overlay"): void {
  const { stdin } = useStdin();
  const hub = useInputHub();
  const ref = useRef(onWheel);
  ref.current = onWheel;
  useMouse(
    (event) => {
      if (event.kind === "wheel") ref.current(event.direction);
    },
    { layer, isActive: hub !== undefined },
  );
  useEffect(() => {
    if (hub) return;
    const listener = (chunk: Buffer | string) => {
      for (const turn of wheelTurns(chunk.toString())) ref.current(turn);
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin, hub]);
}

/** F6 as terminals send it (ESC [ 17 ~), alone or with modifiers. */
const F6 = new RegExp(`${ESC}\\[17(?:;\\d+)?~`, "g");

/** How many times a chunk of input presses F6. */
export function f6Presses(chunk: string): number {
  return [...chunk.matchAll(F6)].length;
}

/**
 * The interface's hold on the mouse. While it holds it, clicks and the wheel
 * are the interface's; once released (F6), the terminal selects and copies
 * text as usual, and F6 again takes the mouse back.
 */
const mouse: { available: boolean; on: boolean; write: (data: string) => void } = {
  available: false,
  on: false,
  write: () => undefined,
};

/** Called once the interface asked for the mouse: from now on F6 can release it. */
export function holdMouse(write: (data: string) => void): void {
  mouse.available = true;
  mouse.on = true;
  mouse.write = write;
}

/** Whether the interface holds the mouse now. */
export function mouseHeld(): boolean {
  return mouse.on;
}

/**
 * Releases the mouse to the terminal, or takes it back. Undefined when the
 * interface never held it (GRAFENO_AGENT_MOUSE=off, or not a terminal).
 */
export function toggleMouse(): boolean | undefined {
  if (!mouse.available) return undefined;
  mouse.on = !mouse.on;
  mouse.write(mouse.on ? MOUSE_ON : MOUSE_OFF);
  return mouse.on;
}
