import { Box, Text } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { Clickable } from "../clicks.js";
import { useKeys, useMenuKey, type Layer } from "../core/input.js";
import { windowStart } from "../picker.js";
import { theme } from "../theme.js";

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly tone?: "success" | "warning" | "error" | "muted" | "memory" | "agent";
  readonly children?: readonly TreeNode[];
}

interface Visible {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parent: string | undefined;
}

/** The nodes on screen: each open node's children under it, in order. */
export function visibleNodes(
  nodes: readonly TreeNode[],
  open: ReadonlySet<string>,
  depth = 0,
  parent?: string,
): Visible[] {
  return nodes.flatMap((node) => [
    { node, depth, parent },
    ...(node.children && open.has(node.id)
      ? visibleNodes(node.children, open, depth + 1, node.id)
      : []),
  ]);
}

/** Every node with children (to open them all). */
function parents(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.id, ...parents(n.children)] : []));
}

/**
 * Nodes inside nodes: ↑↓ move, → opens a node (or goes to its first
 * child), ← closes it (or goes to its parent), Enter opens the node's
 * inspector, Shift+F10 its actions. A click selects (on a node with
 * children, opens or closes it), a double click opens, a right click shows
 * the actions. + is a closed node, − an open one, · a leaf.
 */
export function Tree(props: {
  readonly nodes: readonly TreeNode[];
  /** Nodes on screen at once. Default: 12. */
  readonly height?: number;
  readonly layer?: Layer;
  readonly isActive?: boolean;
  /** Which nodes start open: all of them (the default), or none. */
  readonly open?: "all" | "none";
  readonly onSelect?: (id: string) => void;
  readonly onOpen?: (id: string) => void;
  readonly onMenu?: (id: string) => void;
}): ReactNode {
  const height = props.height ?? 12;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(props.open === "none" ? [] : parents(props.nodes)),
  );
  const [at, setAt] = useState(0);
  const shown = useMemo(() => visibleNodes(props.nodes, open), [props.nodes, open]);
  const chosen = Math.min(at, Math.max(0, shown.length - 1));
  const current = shown[chosen];
  const select = (index: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, index));
    setAt(next);
    const item = shown[next];
    if (item) props.onSelect?.(item.node.id);
  };
  const toggle = (id: string, to?: boolean) => {
    setOpen((was) => {
      const next = new Set(was);
      if (to ?? !was.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const options = {
    layer: props.layer ?? "overlay",
    isActive: props.isActive ?? true,
  };
  useKeys((_input, key) => {
    if (!current) return;
    const { node } = current;
    if (key.upArrow) select(chosen - 1);
    else if (key.downArrow) select(chosen + 1);
    else if (key.pageUp) select(chosen - height);
    else if (key.pageDown) select(chosen + height);
    else if (key.rightArrow) {
      if (node.children && !open.has(node.id)) toggle(node.id, true);
      else if (node.children && node.children.length > 0) select(chosen + 1);
    } else if (key.leftArrow) {
      if (node.children && open.has(node.id)) toggle(node.id, false);
      else if (current.parent !== undefined) {
        select(shown.findIndex((v) => v.node.id === current.parent));
      }
    } else if (key.return) props.onOpen?.(node.id);
  }, options);
  useMenuKey(() => {
    if (current) props.onMenu?.(current.node.id);
  }, options);

  const first = windowStart(chosen, height, shown.length);
  const below = Math.max(0, shown.length - first - height);
  return (
    <Box flexDirection="column">
      {shown.length === 0 && <Text dimColor> Nothing here yet.</Text>}
      {first > 0 && <Text dimColor> ↑ {String(first)} more</Text>}
      {shown.slice(first, first + height).map((item, offset) => {
        const index = first + offset;
        const on = index === chosen;
        const { node } = item;
        const mark = node.children ? (open.has(node.id) ? "− " : "+ ") : "· ";
        return (
          <Clickable
            key={node.id}
            onClick={() => {
              select(index);
              if (node.children) toggle(node.id);
            }}
            onDoubleClick={() => {
              select(index);
              props.onOpen?.(node.id);
            }}
            onRightClick={() => {
              select(index);
              props.onMenu?.(node.id);
            }}
          >
            <Text wrap="truncate-end">
              <Text {...(on ? { color: theme.selected, bold: true } : {})}>
                {on ? "▸ " : "  "}
                {"  ".repeat(item.depth)}
                {mark}
              </Text>
              <Text
                {...(on
                  ? { color: theme.selected, bold: true }
                  : node.tone
                    ? { color: theme[node.tone] }
                    : {})}
              >
                {node.label}
              </Text>
              {node.hint !== undefined && <Text dimColor> {node.hint}</Text>}
            </Text>
          </Clickable>
        );
      })}
      {below > 0 && <Text dimColor> ↓ {String(below)} more</Text>}
    </Box>
  );
}
