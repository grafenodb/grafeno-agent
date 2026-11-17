import { Box, Text } from "ink";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { MemoryAdmin, MemoryHit, MemoryRelation } from "../../app/memory-admin.js";
import { memoryTitle } from "../../app/memory-admin.js";
import { useKeys } from "../core/input.js";
import { Prompt } from "../prompt.js";
import { theme } from "../theme.js";
import { Dialog } from "../ui/dialog.js";
import { Inspector, type Field } from "../ui/inspector.js";
import { Table, type Row } from "../ui/table.js";
import { Tree } from "../ui/tree.js";

type Tab = "search" | "namespaces" | "contradictions";
const TABS: readonly Tab[] = ["search", "namespaces", "contradictions"];
const TAB_TITLE: Readonly<Record<Tab, string>> = {
  search: "Search",
  namespaces: "Namespaces",
  contradictions: "Contradictions",
};

const when = (micros: number) =>
  new Date(micros / 1000).toISOString().slice(0, 16).replace("T", " ");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The memory, explored without leaving the interface: search it, open a
 * memory with its facts (and go from one memory to another), see the
 * contradictions Grafeno recorded, and delete or empty a namespace (a
 * dialog asks for its name, typed in full). Tab moves between the tabs;
 * Esc goes back a step and closes from a tab.
 */
export function MemoryView(props: {
  readonly admin: MemoryAdmin;
  readonly notice: (text: string, tone: "success" | "warning" | "error") => void;
  readonly onClose: () => void;
}): ReactNode {
  const { admin } = props;
  const [tab, setTab] = useState<Tab>("search");
  const [error, setError] = useState<string | undefined>(undefined);
  // Search.
  const [focus, setFocus] = useState<"query" | "results">("query");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly MemoryHit[] | undefined>(undefined);
  const [node, setNode] = useState<
    { title: string; fields: Field[]; relations: readonly MemoryRelation[] } | undefined
  >(undefined);
  // Namespaces.
  const [spaces, setSpaces] = useState<Row[] | undefined>(undefined);
  const [space, setSpace] = useState<{ name: string; fields: Field[] } | undefined>(undefined);
  const [asking, setAsking] = useState<"empty" | "drop" | undefined>(undefined);
  // Contradictions.
  const [contradictions, setContradictions] = useState<Row[] | undefined>(undefined);

  const loadSpaces = useCallback(() => {
    setSpaces(undefined);
    admin.namespaces().then(
      (found) => {
        setSpaces(
          found.map((n) => ({
            id: n.name,
            cells: {
              name: `${n.name}${n.name === admin.active ? " · this session" : ""}`,
              nodes: String(n.nodes),
              edges: String(n.edges),
              created: when(n.created_at),
              description: n.description ?? "",
            },
          })),
        );
      },
      (e: unknown) => {
        setError(message(e));
      },
    );
  }, [admin]);

  useEffect(() => {
    if (tab === "namespaces" && spaces === undefined) loadSpaces();
    if (tab === "contradictions" && contradictions === undefined) {
      admin.contradictions(admin.active).then(
        (found) => {
          setContradictions(
            found.map((c, i) => ({
              id: `${String(i)}-${c.new_edge}`,
              cells: {
                constraint: c.constraint,
                action: c.action,
                recorded: when(c.recorded_at),
                by: c.by ?? "unknown",
              },
            })),
          );
        },
        (e: unknown) => {
          setError(message(e));
        },
      );
    }
  }, [tab, spaces, contradictions, admin, loadSpaces]);

  const openNode = (id: string) => {
    setError(undefined);
    admin.node(admin.active, id).then(
      ({ node: found, relations }) => {
        setNode({
          title: memoryTitle(found),
          relations,
          fields: [
            { label: "Memory", value: memoryTitle(found) },
            { label: "Id", value: found.id },
            { label: "Kinds", value: found.labels.join(", ") || "—", tone: "memory" },
            { label: "Importance", value: found.memory.importance.toFixed(2) },
            { label: "Used", value: `${String(found.memory.accesses)} times` },
            { label: "Created", value: when(found.created_at) },
            { label: "Recorded by", value: found.recorded_by ?? "unknown" },
            {
              label: "Comes from",
              value: found.sources.length > 0 ? `${String(found.sources.length)} memories` : "—",
            },
            { label: "Text", value: (found.text ?? "").replace(/\s+/g, " ").slice(0, 160) || "—" },
          ],
        });
      },
      (e: unknown) => {
        setError(message(e));
      },
    );
  };

  const openSpace = (name: string) => {
    setError(undefined);
    admin.stats(name).then(
      (stats) => {
        const kinds = Object.entries(stats.node_labels)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, n]) => `${label} ${String(n)}`)
          .join(", ");
        setSpace({
          name,
          fields: [
            { label: "Namespace", value: name },
            { label: "Memories", value: String(stats.nodes) },
            { label: "Facts", value: String(stats.edges) },
            { label: "Texts", value: String(stats.texts) },
            { label: "Vectors", value: String(stats.vectors) },
            { label: "Kinds", value: kinds || "—", tone: "memory" },
            {
              label: "This session",
              value: name === admin.active ? "yes: its memory lives here" : "no",
              ...(name === admin.active ? { tone: "warning" as const } : {}),
            },
          ],
        });
      },
      (e: unknown) => {
        setError(message(e));
      },
    );
  };

  const busy = node !== undefined || space !== undefined || asking !== undefined;
  useKeys((_input, key) => {
    if (asking) return;
    if (key.escape) {
      if (node) setNode(undefined);
      else if (space) setSpace(undefined);
      else if (tab === "search" && focus === "results") setFocus("query");
      else props.onClose();
    } else if (key.tab && !busy) {
      const at = TABS.indexOf(tab);
      setTab(TABS[(at + (key.shift ? TABS.length - 1 : 1)) % TABS.length] ?? "search");
      setError(undefined);
    } else if (_input === "/" && tab === "search" && focus === "results" && !busy)
      setFocus("query");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.memory} paddingX={1}>
      <Text>
        <Text bold color={theme.memory}>
          Memory
        </Text>
        <Text dimColor> · {admin.active} · </Text>
        {TABS.map((t) => (
          <Text
            key={t}
            {...(t === tab ? { color: theme.selected, bold: true } : { dimColor: true })}
          >
            {t === tab ? `[${TAB_TITLE[t]}]` : ` ${TAB_TITLE[t]} `}{" "}
          </Text>
        ))}
      </Text>
      {error !== undefined && <Text color={theme.error}>✗ {error}</Text>}

      {tab === "search" && (
        <>
          <Prompt
            active={focus === "query" && !busy}
            commands={false}
            initial={query}
            placeholder="words to look for in the memory"
            onSubmit={(text) => {
              const words = text.trim();
              setQuery(words);
              if (words === "") return;
              setError(undefined);
              setHits(undefined);
              admin.search(admin.active, words).then(
                (found) => {
                  setHits(found);
                  setFocus("results");
                },
                (e: unknown) => {
                  setError(message(e));
                },
              );
            }}
          />
          {hits !== undefined && (
            <Table
              columns={[
                { key: "title", title: "Memory", width: 46 },
                { key: "labels", title: "Kinds", width: 20 },
                { key: "score", title: "Score", align: "right" },
              ]}
              rows={hits.map((h) => ({
                id: h.id,
                cells: { title: h.title, labels: h.labels.join(", "), score: h.score.toFixed(2) },
              }))}
              height={8}
              isActive={focus === "results" && !busy}
              onOpen={openNode}
            />
          )}
          <Text dimColor>
            {focus === "query" ? "enter search" : "enter open · / search again"} · tab next tab ·
            esc {focus === "results" ? "back" : "close"}
          </Text>
        </>
      )}

      {tab === "namespaces" && (
        <>
          {spaces === undefined ? (
            <Text dimColor>asking Grafeno…</Text>
          ) : (
            <Table
              columns={[
                { key: "name", title: "Namespace", width: 26 },
                { key: "nodes", title: "Memories", align: "right" },
                { key: "edges", title: "Facts", align: "right" },
                { key: "created", title: "Created" },
                { key: "description", title: "Description", width: 30 },
              ]}
              rows={spaces}
              height={8}
              isActive={!busy}
              onOpen={openSpace}
            />
          )}
          <Text dimColor>
            enter inspect (empty or delete from there) · tab next tab · esc close
          </Text>
        </>
      )}

      {tab === "contradictions" && (
        <>
          {contradictions === undefined ? (
            <Text dimColor>asking Grafeno…</Text>
          ) : (
            <Table
              columns={[
                { key: "constraint", title: "Rule", width: 26 },
                { key: "action", title: "What it did" },
                { key: "recorded", title: "When" },
                { key: "by", title: "By" },
              ]}
              rows={contradictions}
              height={8}
              isActive={!busy}
            />
          )}
          <Text dimColor>
            what Grafeno did when a new fact met an older one · tab next tab · esc close
          </Text>
        </>
      )}

      {node && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.memory} paddingX={1}>
          {node.fields.map((field) => (
            <Text key={field.label} wrap="truncate-end">
              <Text dimColor>{field.label.padEnd(12)}</Text>
              <Text {...(field.tone ? { color: theme[field.tone] } : {})}>{field.value}</Text>
            </Text>
          ))}
          <Text bold color={theme.memory}>
            Facts ({String(node.relations.length)})
          </Text>
          <Tree
            nodes={node.relations.map((r, i) => ({
              id: `${String(i)}:${r.other.id}`,
              label: `${r.direction === "out" ? "→" : "←"} ${r.label} ${r.other.title}`,
              ...(r.ended ? { hint: "(no longer holds)", tone: "muted" as const } : {}),
            }))}
            height={8}
            onOpen={(id) => {
              openNode(id.slice(id.indexOf(":") + 1));
            }}
          />
          <Text dimColor>enter go to that memory · esc back</Text>
        </Box>
      )}

      {space && !asking && (
        <Inspector
          title={`Namespace · ${space.name}`}
          fields={space.fields}
          actions={[
            { id: "empty", label: "Empty it" },
            { id: "drop", label: "Delete it" },
          ]}
          onAction={(id) => {
            if (id === "drop" && space.name === admin.active) {
              props.notice(
                `${space.name} is this session's memory: it is not deleted from here. Empty it instead, or delete it from another session.`,
                "warning",
              );
              return;
            }
            setAsking(id === "drop" ? "drop" : "empty");
          }}
          onClose={() => {
            setSpace(undefined);
          }}
        />
      )}

      {space && asking && (
        <Dialog
          danger
          title={
            asking === "drop"
              ? `Delete the namespace ${space.name}?`
              : `Empty the namespace ${space.name}?`
          }
          message={
            asking === "drop"
              ? "Every memory and fact in it goes, and the namespace too. It cannot be undone."
              : `Every memory and fact in it goes; the namespace stays, empty. It cannot be undone.${
                  space.name === admin.active ? " This session goes on with an empty memory." : ""
                }`
          }
          typeToConfirm={space.name}
          confirmLabel={asking === "drop" ? "Delete" : "Empty"}
          onCancel={() => {
            setAsking(undefined);
          }}
          onConfirm={() => {
            const name = space.name;
            const doing = asking;
            setAsking(undefined);
            setSpace(undefined);
            (doing === "drop" ? admin.drop(name) : admin.empty(name)).then(
              () => {
                props.notice(
                  doing === "drop"
                    ? `The namespace ${name} is deleted.`
                    : `The namespace ${name} is empty now.`,
                  "success",
                );
                loadSpaces();
              },
              (e: unknown) => {
                props.notice(`${name}: ${message(e)}`, "error");
                loadSpaces();
              },
            );
          }}
        />
      )}
    </Box>
  );
}
