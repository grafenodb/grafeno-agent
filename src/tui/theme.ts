/** The colors of the terminal interface: Grafeno's mint green, on the terminal's own background. */
export const theme = {
  brand: "#7fdcbf",
  accent: "#3fd0a8",
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
