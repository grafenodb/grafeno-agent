import { Box, Text } from "ink";
import { useState, type ReactNode } from "react";
import { Clickable } from "../clicks.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";

/**
 * A question that must be answered before anything else: yes or no, or,
 * for what cannot be undone, a name typed in full. It has the keys while
 * it is open; Esc is always no.
 *
 * - y or Enter: yes (when a name is asked, only once it is typed exactly);
 * - n or Esc: no;
 * - a click on either does the same.
 */
export function Dialog(props: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** What cannot be undone: said in red. */
  readonly danger?: boolean;
  /** Asked to be typed in full before yes is taken (a namespace's name). */
  readonly typeToConfirm?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [typed, setTyped] = useState("");
  const asking = props.typeToConfirm !== undefined;
  const ready = !asking || typed === props.typeToConfirm;
  const confirm = () => {
    if (ready) props.onConfirm();
  };
  useKeys((input, key) => {
    if (key.escape) props.onCancel();
    else if (key.return) confirm();
    else if (asking) {
      if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab) setTyped((t) => t + input);
    } else if (input === "y" || input === "Y") confirm();
    else if (input === "n" || input === "N") props.onCancel();
  });
  const color = props.danger === true ? theme.error : theme.focus;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text bold color={color}>
        {props.danger === true ? "! " : ""}
        {props.title}
      </Text>
      <Text>{props.message}</Text>
      {asking && (
        <Text>
          <Text dimColor>Type {props.typeToConfirm} to confirm: </Text>
          <Text color={ready ? theme.success : theme.warning}>{typed === "" ? "…" : typed}</Text>
          {ready && <Text color={theme.success}> ✓</Text>}
        </Text>
      )}
      <Box marginTop={1} gap={2}>
        <Clickable onClick={confirm}>
          <Text {...(ready ? { color } : { dimColor: true })} bold={ready}>
            [{asking ? "enter" : "y"}] {props.confirmLabel ?? "Yes"}
          </Text>
        </Clickable>
        <Clickable onClick={props.onCancel}>
          <Text dimColor>
            [{asking ? "esc" : "n"}] {props.cancelLabel ?? "No"}
          </Text>
        </Clickable>
      </Box>
    </Box>
  );
}
