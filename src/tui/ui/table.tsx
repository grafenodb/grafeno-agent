import { Box, Text } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { Clickable } from "../clicks.js";
import { useKeys, useMenuKey, type Layer } from "../core/input.js";
import { windowStart } from "../picker.js";
import { theme } from "../theme.js";

export interface Column {
  readonly key: string;
  readonly title: string;
  /** Its width in columns; default: its widest cell (up to 40). */
  readonly width?: number;
  readonly align?: "left" | "right";
}

export interface Row {
  readonly id: string;
  readonly cells: Readonly<Record<string, string>>;
  /** What the row says (a failed run): by color, beside the words in its cells. */
  readonly tone?: "success" | "warning" | "error" | "muted";
}

export interface TableProps {
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /** Rows on screen at once. Default: 10. */
  readonly height?: number;
  readonly layer?: Layer;
  readonly isActive?: boolean;
  /** Sorted by a column (←→ change it, r reverses). Default: as given. */
  readonly sortable?: boolean;
  readonly onSelect?: (id: string) => void;
  /** Enter, or a double click: the row's inspector. */
  readonly onOpen?: (id: string) => void;
  /** Shift+F10, the Menu key or a right click: the row's actions. */
  readonly onMenu?: (id: string) => void;
}

const MAX_WIDTH = 40;

function cut(text: string, width: number, align: "left" | "right" = "left"): string {
  const shown = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return align === "right" ? shown.padStart(width) : shown.padEnd(width);
}

/**
 * Rows and columns with a selection: ↑↓ PgUp PgDn Home End move, Enter
 * opens, Shift+F10 shows the row's actions; ←→ choose the column it is
 * sorted by and r reverses it (when sortable). A click selects, a double
 * click opens, a right click shows the actions.
 */
export function Table(props: TableProps): ReactNode {
  const height = props.height ?? 10;
  const [at, setAt] = useState(0);
  const [sort, setSort] = useState<{ index: number; desc: boolean } | undefined>(undefined);
  const rows = useMemo(() => {
    if (!sort) return props.rows;
    const key = props.columns[sort.index]?.key ?? "";
    const sorted = [...props.rows].sort((a, b) =>
      (a.cells[key] ?? "").localeCompare(b.cells[key] ?? "", undefined, { numeric: true }),
    );
    return sort.desc ? sorted.reverse() : sorted;
  }, [props.rows, props.columns, sort]);
  const chosen = Math.min(at, Math.max(0, rows.length - 1));
  const select = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setAt(next);
    const row = rows[next];
    if (row) props.onSelect?.(row.id);
  };
  const current = rows[chosen];
  const options = {
    layer: props.layer ?? "overlay",
    isActive: props.isActive ?? true,
  };
  useKeys((input, key) => {
    if (key.upArrow) select(chosen - 1);
    else if (key.downArrow) select(chosen + 1);
    else if (key.pageUp) select(chosen - height);
    else if (key.pageDown) select(chosen + height);
    else if (key.home) select(0);
    else if (key.end) select(rows.length - 1);
    else if (key.return && current) props.onOpen?.(current.id);
    else if (props.sortable === true && (key.leftArrow || key.rightArrow)) {
      const count = props.columns.length;
      setSort((was) => ({
        index:
          ((was?.index ?? (key.rightArrow ? -1 : 0)) + (key.rightArrow ? 1 : count - 1)) % count,
        desc: false,
      }));
    } else if (props.sortable === true && input === "r") {
      setSort((was) => (was ? { ...was, desc: !was.desc } : { index: 0, desc: true }));
    }
  }, options);
  useMenuKey(() => {
    if (current) props.onMenu?.(current.id);
  }, options);

  const widths = props.columns.map(
    (c) =>
      c.width ??
      Math.min(
        MAX_WIDTH,
        Math.max(c.title.length + 2, ...rows.map((r) => (r.cells[c.key] ?? "").length)),
      ),
  );
  const first = windowStart(chosen, height, rows.length);
  const below = Math.max(0, rows.length - first - height);
  return (
    <Box flexDirection="column">
      <Text bold>
        {"  "}
        {props.columns
          .map((c, i) => {
            const mark = sort?.index === i ? (sort.desc ? " ▼" : " ▲") : "";
            return cut(`${c.title}${mark}`, widths[i] ?? 10, c.align);
          })
          .join(" ")}
      </Text>
      {rows.length === 0 && <Text dimColor> Nothing here yet.</Text>}
      {first > 0 && <Text dimColor> ↑ {String(first)} more</Text>}
      {rows.slice(first, first + height).map((row, offset) => {
        const index = first + offset;
        const on = index === chosen;
        const text = props.columns
          .map((c, i) => cut(row.cells[c.key] ?? "", widths[i] ?? 10, c.align))
          .join(" ");
        return (
          <Clickable
            key={row.id}
            onClick={() => {
              select(index);
            }}
            onDoubleClick={() => {
              select(index);
              props.onOpen?.(row.id);
            }}
            onRightClick={() => {
              select(index);
              props.onMenu?.(row.id);
            }}
          >
            <Text
              wrap="truncate-end"
              {...(on
                ? { color: theme.selected, bold: true }
                : row.tone
                  ? { color: theme[row.tone] }
                  : {})}
            >
              {on ? "▸ " : "  "}
              {text}
            </Text>
          </Clickable>
        );
      })}
      {below > 0 && <Text dimColor> ↓ {String(below)} more</Text>}
    </Box>
  );
}
