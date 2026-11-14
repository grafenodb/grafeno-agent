import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import { theme } from "./theme.js";

export interface PickerItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Marked as the current one. */
  readonly current?: boolean;
}

export interface PickerProps {
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly onSelect: (item: PickerItem) => void;
  readonly onCancel: () => void;
  /** Rows shown at once. Default: 10. */
  readonly rows?: number;
}

/** A list to choose from with the arrows and Enter; Escape leaves it. */
export function Picker(props: PickerProps): ReactNode {
  const start = Math.max(
    0,
    props.items.findIndex((item) => item.current === true),
  );
  const [selected, setSelected] = useState(start);
  const rows = props.rows ?? 10;
  const count = props.items.length;

  useInput((input, key) => {
    if (key.escape) props.onCancel();
    else if (key.upArrow) setSelected((s) => (s - 1 + count) % count);
    else if (key.downArrow) setSelected((s) => (s + 1) % count);
    else if (key.pageUp) setSelected((s) => Math.max(0, s - rows));
    else if (key.pageDown) setSelected((s) => Math.min(count - 1, s + rows));
    else if (key.return) {
      const item = props.items[selected];
      if (item) props.onSelect(item);
    } else if (/^[1-9]$/.test(input)) {
      const item = props.items[Number(input) - 1];
      if (item) props.onSelect(item);
    }
  });

  const first = Math.max(0, Math.min(selected - rows + 1, count - rows));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>
        {props.title}
      </Text>
      {count === 0 && <Text dimColor>Nothing to choose from.</Text>}
      {props.items.slice(first, first + rows).map((item, index) => {
        const on = first + index === selected;
        return (
          <Box key={item.id}>
            <Box flexShrink={0}>
              <Text {...(on ? { color: theme.accent } : {})} bold={on}>
                {on ? "▸ " : "  "}
                {item.label}
              </Text>
              {item.current === true && <Text color={theme.success}> ●</Text>}
            </Box>
            {item.hint !== undefined && <Text dimColor> {item.hint}</Text>}
          </Box>
        );
      })}
      <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
    </Box>
  );
}
