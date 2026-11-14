import { Box, Text } from "ink";
import type { ReactNode } from "react";

/**
 * Grafeno's mark for the terminal: three fused carbon rings around a core
 * atom, drawn with line characters, mint green from light to deep, on the
 * terminal's own background.
 */
const MARK = [
  "    ●     ●    ",
  "  ╱   ╲ ╱   ╲  ",
  " ●     ●     ● ",
  " │     │     │ ",
  " ●     ◉     ● ",
  "  ╲   ╱ ╲   ╱  ",
  "    ●     ●    ",
  "    │     │    ",
  "    ●     ●    ",
  "      ╲ ╱      ",
  "       ●       ",
] as const;

/** From the top of the mark to its foot: the brand's bond gradient. */
const SHADES = [
  "#d6f7e8",
  "#c2f1de",
  "#a7ecd2",
  "#94e5c8",
  "#7fdcbf",
  "#6ad3b4",
  "#55c9a8",
  "#47bf9f",
  "#3ab594",
  "#2eae8e",
  "#22a888",
] as const;

export const BRAND = "#7fdcbf";
export const CORE = "#ffffff";

/** The mark alone. */
export function Mark(): ReactNode {
  return (
    <Box flexDirection="column">
      {MARK.map((line, row) => {
        const core = line.indexOf("◉");
        const color = SHADES[row] ?? BRAND;
        if (core === -1) {
          return (
            <Text key={row} color={color}>
              {line}
            </Text>
          );
        }
        return (
          <Text key={row} color={color}>
            {line.slice(0, core)}
            <Text color={CORE} bold>
              ◉
            </Text>
            {line.slice(core + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

/** The mark with the name beside it, for the start screen. */
export function Logo({
  version,
  tagline,
}: {
  readonly version: string;
  readonly tagline?: string;
}): ReactNode {
  return (
    <Box flexDirection="row" alignItems="center" gap={3}>
      <Mark />
      <Box flexDirection="column">
        <Text bold color={BRAND}>
          G R A F E N O
        </Text>
        <Text bold>Agent</Text>
        <Text dimColor>v{version}</Text>
        {tagline !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{tagline}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** The mark in one line, for headers: ⬡. */
export function Glyph(): ReactNode {
  return (
    <Text color={BRAND} bold>
      ⬡
    </Text>
  );
}
