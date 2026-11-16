import { Box, Text, useInput, useWindowSize } from "ink";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { theme } from "./theme.js";
import { Clickable } from "./clicks.js";
import { useWheel } from "./mouse.js";

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
  /** Rows shown at once. Default: as many as the terminal has room for, up to 12. */
  readonly rows?: number;
  /**
   * Typing searches the items (by name, hint or id). Default: on for long
   * lists (more than 12), where numbers do not choose.
   */
  readonly search?: boolean;
}

/** Whether an item matches what was typed: every word, in its name, hint or id, in any case. */
export function matchesQuery(item: PickerItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const where = `${item.label} ${item.hint ?? ""} ${item.id}`.toLowerCase();
  return words.every((w) => where.includes(w));
}

/** The rows a list may take in this terminal: what is left once the rest of the screen is drawn. */
export function useListRows(wanted: number | undefined, most = 12, reserved = 14): number {
  const { rows } = useWindowSize();
  if (wanted !== undefined) return wanted;
  // A terminal that does not say its height: room for the whole list.
  const height = rows > 0 ? rows : 200;
  return Math.max(4, Math.min(most, height - reserved));
}

/** The first row shown so that the selected one is in view. */
export function windowStart(selected: number, rows: number, count: number): number {
  return Math.max(0, Math.min(selected - rows + 1, count - rows, selected));
}

/**
 * A list to choose from: the arrows, Page Up / Page Down or the mouse wheel
 * move through it (it scrolls when it is longer than the screen), Enter or
 * a click chooses, Escape leaves it. A long list is searched by typing.
 */
export function Picker(props: PickerProps): ReactNode {
  const searching = props.search ?? props.items.length > 12;
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () => (query === "" ? props.items : props.items.filter((i) => matchesQuery(i, query))),
    [props.items, query],
  );
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      props.items.findIndex((item) => item.current === true),
    ),
  );
  const rows = useListRows(props.rows, 12, searching ? 15 : 14);
  const count = shown.length;
  const at = Math.min(selected, Math.max(0, count - 1));

  const move = useCallback(
    (by: number) => {
      setSelected((s) =>
        Math.max(0, Math.min(Math.max(0, count - 1), Math.min(s, count - 1) + by)),
      );
    },
    [count],
  );
  useWheel(
    useCallback(
      (direction: number) => {
        move(-direction);
      },
      [move],
    ),
  );

  useInput((input, key) => {
    if (key.escape) {
      if (query !== "") {
        setQuery("");
        setSelected(0);
      } else props.onCancel();
    } else if (key.upArrow) setSelected((at - 1 + count) % Math.max(1, count));
    else if (key.downArrow) setSelected((at + 1) % Math.max(1, count));
    else if (key.pageUp) move(-rows);
    else if (key.pageDown) move(rows);
    else if (key.return) {
      const item = shown[at];
      if (item) props.onSelect(item);
    } else if (searching) {
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSelected(0);
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        setQuery((q) => q + input);
        setSelected(0);
      }
    } else if (/^[1-9]$/.test(input)) {
      const item = shown[Number(input) - 1];
      if (item) props.onSelect(item);
    }
  });

  const first = windowStart(at, rows, count);
  const below = Math.max(0, count - first - rows);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>
          {props.title}
        </Text>
        {searching && (
          <>
            <Text dimColor>
              {" "}
              · {String(count)}
              {query === "" ? "" : ` of ${String(props.items.length)}`} · search:{" "}
            </Text>
            <Text color={theme.accent}>{query === "" ? "type a name" : query}</Text>
          </>
        )}
      </Text>
      {props.items.length === 0 && <Text dimColor>Nothing to choose from.</Text>}
      {props.items.length > 0 && count === 0 && (
        <Text color={theme.warning}>Nothing matches “{query}”. esc clears the search.</Text>
      )}
      {first > 0 && <Text dimColor> ↑ {String(first)} more</Text>}
      {shown.slice(first, first + rows).map((item, index) => {
        const on = first + index === at;
        return (
          <Clickable
            key={item.id}
            onClick={() => {
              props.onSelect(item);
            }}
          >
            <Box flexShrink={0}>
              <Text {...(on ? { color: theme.accent } : {})} bold={on}>
                {on ? "▸ " : "  "}
                {item.label}
              </Text>
              {item.current === true && <Text color={theme.success}> ●</Text>}
            </Box>
            {item.hint !== undefined && <Text dimColor> {item.hint}</Text>}
          </Clickable>
        );
      })}
      {below > 0 && <Text dimColor> ↓ {String(below)} more</Text>}
      <Box>
        <Text dimColor>
          {searching ? "type to search · " : ""}↑↓ wheel move · enter or click choose ·{" "}
        </Text>
        <Clickable onClick={props.onCancel}>
          <Text dimColor underline>
            esc {query === "" ? "cancel" : "clear"}
          </Text>
        </Clickable>
      </Box>
    </Box>
  );
}
