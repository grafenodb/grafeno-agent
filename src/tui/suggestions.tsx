import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { Clickable } from "./clicks.js";
import { theme } from "./theme.js";

/** Commands worth a click from an empty prompt: each one opens a view. */
export const SUGGESTIONS: readonly string[] = ["/models", "/vault", "/runs", "/providers"];

/**
 * The line under the prompt: a few commands, each a click away (or typed:
 * every one is a command), so what the panels open is never hidden.
 */
export function Suggestions(props: { readonly onPick: (command: string) => void }): ReactNode {
  return (
    <Box flexShrink={0} overflow="hidden">
      <Text dimColor>suggestions: </Text>
      {SUGGESTIONS.map((command) => (
        <Clickable
          key={command}
          onClick={() => {
            props.onPick(command);
          }}
        >
          <Text color={theme.focus}>{command} </Text>
        </Clickable>
      ))}
    </Box>
  );
}
