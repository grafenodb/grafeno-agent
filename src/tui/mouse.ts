import { useStdin } from "ink";
import { useEffect } from "react";

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
 * wheel. Ink reads the same input and drops the mouse reports, so typing is
 * never disturbed.
 */
export function useWheel(onWheel: (direction: number) => void): void {
  const { stdin } = useStdin();
  useEffect(() => {
    const listener = (chunk: Buffer | string) => {
      for (const turn of wheelTurns(chunk.toString())) onWheel(turn);
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin, onWheel]);
}
