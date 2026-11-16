import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import { Clickable } from "./clicks.js";
import { theme } from "./theme.js";

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
}

export interface SessionsPanelProps {
  readonly sessions: readonly SessionRow[];
  readonly onResume: (id: string) => void;
  /** Deletes a conversation for good; the panel asks first. */
  readonly onDelete: (row: SessionRow) => void;
  readonly onCancel: () => void;
  /** Rows shown at once. Default: 10. */
  readonly rows?: number;
}

/**
 * The project's earlier conversations: take one up again (Enter or a click
 * on it), or delete one (d, or its [delete]), which asks before it deletes,
 * since a deleted conversation cannot be brought back.
 */
export function SessionsPanel(props: SessionsPanelProps): ReactNode {
  const [selected, setSelected] = useState(0);
  const [confirming, setConfirming] = useState<SessionRow | undefined>(undefined);
  const rows = props.rows ?? 10;
  const count = props.sessions.length;
  const at = Math.min(selected, Math.max(0, count - 1));

  const remove = (row: SessionRow) => {
    setConfirming(undefined);
    props.onDelete(row);
    setSelected((s) => Math.max(0, Math.min(s, count - 2)));
  };

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" || input === "Y") remove(confirming);
      else if (input === "n" || input === "N" || key.escape) setConfirming(undefined);
      return;
    }
    if (key.escape) props.onCancel();
    else if (key.upArrow) setSelected((s) => (s - 1 + count) % Math.max(1, count));
    else if (key.downArrow) setSelected((s) => (s + 1) % Math.max(1, count));
    else if (key.return) {
      const row = props.sessions[at];
      if (row) props.onResume(row.id);
    } else if (input === "d" || input === "D" || key.delete) {
      const row = props.sessions[at];
      if (row) setConfirming(row);
    }
  });

  const first = Math.max(0, Math.min(at - rows + 1, count - rows));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>
        Conversations of this project
      </Text>
      {count === 0 && <Text dimColor>No earlier conversations.</Text>}
      {props.sessions.slice(first, first + rows).map((row, index) => {
        const on = first + index === at;
        return (
          <Box key={row.id}>
            <Clickable
              flexGrow={1}
              onClick={() => {
                props.onResume(row.id);
              }}
            >
              <Text {...(on ? { color: theme.accent } : {})} bold={on} wrap="truncate-end">
                {on ? "▸ " : "  "}
                {row.title}
                <Text dimColor bold={false}>
                  {" "}
                  {row.hint}
                </Text>
              </Text>
            </Clickable>
            <Clickable
              flexShrink={0}
              onClick={() => {
                setSelected(first + index);
                setConfirming(row);
              }}
            >
              <Text color={theme.error} dimColor={!on}>
                {" "}
                [delete]
              </Text>
            </Clickable>
          </Box>
        );
      })}
      {confirming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.warning}>
            Delete “{confirming.title}”? It cannot be undone (what the agent stored in its memory
            stays).
          </Text>
          <Box gap={2}>
            <Clickable
              onClick={() => {
                remove(confirming);
              }}
            >
              <Text color={theme.error} bold inverse>
                {" y delete "}
              </Text>
            </Clickable>
            <Clickable
              onClick={() => {
                setConfirming(undefined);
              }}
            >
              <Text bold inverse>
                {" n keep "}
              </Text>
            </Clickable>
          </Box>
        </Box>
      ) : (
        <Text dimColor>↑↓ move · enter or click resume · d or [delete] delete · esc close</Text>
      )}
    </Box>
  );
}
