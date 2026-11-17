/**
 * The colors of the terminal interface, on the terminal's own background.
 * Grafeno's mint green is the brand; the rest say what something is:
 * - `focus` / `selected` (cyan): where the keys go, the row chosen, paths;
 * - `success` (green), `warning` (yellow), `error` (red): states;
 * - `memory` / `agent` (violet): what memory brought, the agents;
 * - `muted` (gray): what is secondary.
 * A color never says something alone: a mark (▸ ✓ ✗ ● ○ !) or a word does
 * too. Terminals with fewer colors get the nearest ones (and none with
 * NO_COLOR), so nothing is lost but the shade.
 */
export const theme = {
  brand: "#7fdcbf",
  accent: "#3fd0a8",
  focus: "#7dcfff",
  selected: "#7dcfff",
  memory: "#bb9af7",
  agent: "#bb9af7",
  user: "#e0af68",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  code: "#a7ecd2",
  muted: "gray",
  border: "#3b5a52",
  panel: "#2e4a43",
} as const;

/** Spinner frames. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
