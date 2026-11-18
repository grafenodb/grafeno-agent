import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { Clickable } from "../clicks.js";
import { theme } from "../theme.js";

/**
 * A titled box, as every panel of the screen is drawn: its title in its
 * color on the first line, a border that turns cyan while the keyboard is
 * in it (a ▸ before the title says so too).
 */
export function Frame(props: {
  readonly title: string;
  readonly color?: string;
  /** A note after the title (dim). */
  readonly note?: string | undefined;
  /** The keyboard is in it. */
  readonly focused?: boolean;
  /** Takes the room left in its column. */
  readonly grow?: boolean;
  readonly width?: number;
  readonly onClick?: (() => void) | undefined;
  readonly onRightClick?: (() => void) | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const focused = props.focused === true;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.focus : theme.border}
      paddingX={1}
      flexShrink={props.grow === true ? 1 : 0}
      {...(props.grow === true ? { flexGrow: 1 } : {})}
      {...(props.width === undefined ? {} : { width: props.width })}
      overflow="hidden"
    >
      <Clickable onClick={props.onClick} onRightClick={props.onRightClick}>
        <Text wrap="truncate-end">
          {focused && <Text color={theme.focus}>▸ </Text>}
          <Text bold color={focused ? theme.focus : (props.color ?? theme.accent)}>
            {props.title}
          </Text>
          {props.note !== undefined && <Text dimColor> · {props.note}</Text>}
        </Text>
      </Clickable>
      {props.children}
    </Box>
  );
}
