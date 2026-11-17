import { Box, Text } from "ink";
import { useState, type ReactNode } from "react";
import { Clickable } from "../clicks.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";

/** One line of what is known of something: a label and its value. */
export interface Field {
  readonly label: string;
  readonly value: string;
  /** What the value says: shown by color and by its words. */
  readonly tone?: "success" | "warning" | "error" | "muted" | "memory" | "agent";
}

/** Something to do with what is inspected. */
export interface InspectorAction {
  readonly id: string;
  readonly label: string;
}

/**
 * The details of the thing selected, over what is on screen: its fields,
 * as the system knows them ("unknown" when it does not, never a guess), and
 * what can be done with it. ↑↓ or ←→ choose an action, Enter (or a click)
 * does it, a number does the one it names, Esc closes.
 */
export function Inspector(props: {
  readonly title: string;
  readonly fields: readonly Field[];
  readonly actions?: readonly InspectorAction[];
  readonly onAction?: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const actions = props.actions ?? [];
  const [at, setAt] = useState(0);
  const chosen = Math.min(at, Math.max(0, actions.length - 1));
  const run = (index: number) => {
    const action = actions[index];
    if (action) props.onAction?.(action.id);
  };
  useKeys((input, key) => {
    if (key.escape) props.onClose();
    else if (key.upArrow || key.leftArrow) setAt(Math.max(0, chosen - 1));
    else if (key.downArrow || key.rightArrow || key.tab)
      setAt(Math.min(actions.length - 1, chosen + 1));
    else if (key.return) run(chosen);
    else if (/^[1-9]$/.test(input)) run(Number(input) - 1);
  });
  const width = Math.max(0, ...props.fields.map((f) => f.label.length));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <Text>
        <Text bold color={theme.focus}>
          {props.title}
        </Text>
        <Text dimColor> · esc close</Text>
      </Text>
      {props.fields.map((field) => (
        <Text key={field.label} wrap="truncate-end">
          <Text dimColor>{field.label.padEnd(width)} </Text>
          <Text {...(field.tone ? { color: theme[field.tone] } : {})}>{field.value}</Text>
        </Text>
      ))}
      {actions.length > 0 && (
        <Box marginTop={1} gap={2} flexWrap="wrap">
          {actions.map((action, index) => (
            <Clickable
              key={action.id}
              onClick={() => {
                run(index);
              }}
            >
              <Text
                {...(index === chosen ? { color: theme.selected, bold: true } : { dimColor: true })}
              >
                {index === chosen ? "▸ " : "  "}[{String(index + 1)}] {action.label}
              </Text>
            </Clickable>
          ))}
        </Box>
      )}
    </Box>
  );
}
