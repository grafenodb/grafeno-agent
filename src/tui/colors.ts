/**
 * NO_COLOR (no-color.org): no colors at all. The terminal library reads
 * FORCE_COLOR, and not NO_COLOR, when it loads, so it is told in its words
 * (unless FORCE_COLOR was set on purpose). TERM=dumb it reads itself.
 */
export function applyNoColor(env: Record<string, string | undefined>): void {
  if ((env.NO_COLOR ?? "") !== "" && env.FORCE_COLOR === undefined) env.FORCE_COLOR = "0";
}
