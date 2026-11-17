import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useKeys } from "./core/input.js";
import type { Layout } from "./core/layout.js";
import { theme } from "./theme.js";

/**
 * The interface's frame: the same regions for everything it shows. The
 * header and the menu on top, then the agents panel (left), the
 * conversation with its prompt (main) and the side panel (right), as wide
 * as the layout says, and the status bar at the bottom. What opens over
 * the conversation (a menu, a dialog) is drawn by the main region.
 */
export function Shell(props: {
  readonly columns: number;
  readonly rows: number;
  readonly layout: Layout;
  readonly header: ReactNode;
  readonly menu: ReactNode;
  readonly left?: (width: number) => ReactNode;
  readonly main: ReactNode;
  readonly right?: (width: number) => ReactNode;
  readonly status: ReactNode;
}): ReactNode {
  const { layout } = props;
  return (
    <Box flexDirection="column" height={props.rows} width={props.columns}>
      {props.header}
      {props.menu}
      <Box flexDirection="row" flexGrow={1}>
        {layout.left > 0 && props.left?.(layout.left)}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {props.main}
        </Box>
        {layout.right > 0 && props.right?.(layout.right)}
      </Box>
      {props.status}
    </Box>
  );
}

/**
 * A panel opened over the conversation (in a window too narrow to show it
 * beside it): it has the keys until Esc or Ctrl+B closes it.
 */
export function PanelOverlay(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === "b")) props.onClose();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <Text>
        <Text bold color={theme.focus}>
          {props.title}
        </Text>
        <Text dimColor> · esc or ctrl+b close</Text>
      </Text>
      {props.children}
    </Box>
  );
}
