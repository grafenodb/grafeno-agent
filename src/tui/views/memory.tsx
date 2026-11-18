import { Box, Text } from "ink";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Duplicate, MemoryAdmin, MemoryHit, MemoryRelation } from "../../app/memory-admin.js";
import { memoryTitle } from "../../app/memory-admin.js";
import { useKeys } from "../core/input.js";
import { Prompt } from "../prompt.js";
import { theme } from "../theme.js";
import { ContextMenu } from "../ui/context-menu.js";
import { Dialog } from "../ui/dialog.js";
import { Inspector, type Field } from "../ui/inspector.js";
import { Table, type Row } from "../ui/table.js";
import { Tree } from "../ui/tree.js";

export type Tab = "browse" | "search" | "duplicates" | "contradictions" | "namespaces";
const TABS: readonly Tab[] = ["browse", "search", "duplicates", "contradictions", "namespaces"];
const TAB_TITLE: Readonly<Record<Tab, string>> = {
  browse: "Browse",
  search: "Search",
  duplicates: "Duplicates",
  contradictions: "Contradictions",
  namespaces: "Namespaces",
};

/** What the words of the memory mean, said once at the top. */
export const MEMORY_WORDS =
  "memories: what was remembered · facts: the links between them · kinds: what each memory is";

/** What the agent is asked when the memory should be consolidated (it writes the summaries). */
export const CONSOLIDATE_PROMPT =
  "Look after the memory: call maintain, then consolidate the groups of old memories it suggests (write each summary from those memories themselves, nothing else), and merge the clear duplicates. Say what you did.";

const when = (micros: number) =>
  new Date(micros / 1000).toISOString().slice(0, 16).replace("T", " ");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The memory, explored without leaving the interface. **Browse** walks it
 * without knowing any name (of a kind, or all, a page at a time);
 * **Search** finds it by words; a memory opens with its facts (Enter on
 * one goes to the memory it links), and Del or x forgets it.
 * **Duplicates** lists what Grafeno takes for the same memory, merged with
 * Enter (u undoes the last merge); c asks the agent to consolidate old
 * memories. **Contradictions**, as Grafeno recorded them. **Namespaces**,
 * emptied or deleted after the name is typed in full. Tab moves between
 * the tabs; Esc goes back a step and closes from a tab.
 */
export function MemoryView(props: {
  readonly admin: MemoryAdmin;
  /** The tab it opens on. Default: Browse. */
  readonly tab?: Tab;
  readonly notice: (text: string, tone: "success" | "warning" | "error") => void;
  /** Asks the agent something (to consolidate the memory); the view closes. */
  readonly onAsk?: (prompt: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { admin } = props;
  const [tab, setTab] = useState<Tab>(props.tab ?? "browse");
  const [error, setError] = useState<string | undefined>(undefined);
  // Browse.
  const [kinds, setKinds] = useState<readonly string[]>([]);
  const [kind, setKind] = useState(0);
  const [page, setPage] = useState<{ items: MemoryHit[]; next: string | null } | undefined>(
    undefined,
  );
  // Search.
  const [focus, setFocus] = useState<"query" | "results">("query");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly MemoryHit[] | undefined>(undefined);
  // A memory open, and forgetting it.
  const [node, setNode] = useState<
    { id: string; title: string; fields: Field[]; relations: readonly MemoryRelation[] } | undefined
  >(undefined);
  const [forgetting, setForgetting] = useState(false);
  // Duplicates.
  const [pairs, setPairs] = useState<readonly Duplicate[] | undefined>(undefined);
  const [pair, setPair] = useState<Duplicate | undefined>(undefined);
  const [lastMerge, setLastMerge] = useState<string | undefined>(undefined);
  // Namespaces.
  const [spaces, setSpaces] = useState<Row[] | undefined>(undefined);
  const [space, setSpace] = useState<{ name: string; fields: Field[] } | undefined>(undefined);
  const [asking, setAsking] = useState<"empty" | "drop" | undefined>(undefined);
  // Contradictions.
  const [contradictions, setContradictions] = useState<Row[] | undefined>(undefined);

  const kindNow = kind === 0 ? undefined : kinds[kind - 1];
  const loadPage = useCallback(
    (after?: string) => {
      setError(undefined);
      admin
        .list(admin.active, { ...(kindNow ? { kind: kindNow } : {}), ...(after ? { after } : {}) })
        .then(
          (found) => {
            setPage((was) => ({
              items: after && was ? [...was.items, ...found.items] : [...found.items],
              next: found.next,
            }));
          },
          (e: unknown) => {
            setError(message(e));
          },
        );
    },
    [admin, kindNow],
  );
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
  const loadPairs = useCallback(() => {
    setPairs(undefined);
    admin.duplicates(admin.active).then(setPairs, (e: unknown) => {
      setError(message(e));
    });
  }, [admin]);

  // The kinds, once: what Browse filters by.
  useEffect(() => {
    admin.stats(admin.active).then(
      (stats) => {
        setKinds(
          Object.entries(stats.node_labels)
            .sort((a, b) => b[1] - a[1])
            .map(([label]) => label),
        );
      },
      () => undefined,
    );
  }, [admin]);
  // Browse, again for each kind.
  useEffect(() => {
    if (tab === "browse") loadPage();
  }, [tab, loadPage]);
  useEffect(() => {
    if (tab === "namespaces" && spaces === undefined) loadSpaces();
    if (tab === "duplicates" && pairs === undefined) loadPairs();
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
  }, [tab, spaces, pairs, contradictions, admin, loadSpaces, loadPairs]);

  const openNode = (id: string) => {
    setError(undefined);
    admin.node(admin.active, id).then(
      ({ node: found, relations }) => {
        setNode({
          id: found.id,
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
        const top = Object.entries(stats.node_labels)
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
            { label: "Kinds", value: top || "—", tone: "memory" },
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

  const busy =
    node !== undefined ||
    space !== undefined ||
    asking !== undefined ||
    pair !== undefined ||
    forgetting;
  useKeys((input, key) => {
    if (asking || forgetting || pair) return;
    if (node) {
      if (key.escape) setNode(undefined);
      else if (key.delete || input === "x") setForgetting(true);
      return;
    }
    if (key.escape) {
      if (space) setSpace(undefined);
      else if (tab === "search" && focus === "results") setFocus("query");
      else props.onClose();
    } else if (key.tab && !busy) {
      const at = TABS.indexOf(tab);
      setTab(TABS[(at + (key.shift ? TABS.length - 1 : 1)) % TABS.length] ?? "browse");
      setError(undefined);
    } else if (busy) return;
    else if (tab === "browse" && (key.leftArrow || key.rightArrow)) {
      const count = kinds.length + 1;
      setKind((k) => (k + (key.rightArrow ? 1 : count - 1)) % count);
    } else if (tab === "browse" && input === "n" && page?.next) loadPage(page.next);
    else if (tab === "search" && focus === "results" && input === "/") setFocus("query");
    else if (tab === "duplicates" && input === "u" && lastMerge) {
      const undo = lastMerge;
      setLastMerge(undefined);
      admin.undoMerge(admin.active, undo).then(
        () => {
          props.notice("The last merge is undone: both memories are back.", "success");
          loadPairs();
        },
        (e: unknown) => {
          props.notice(message(e), "error");
        },
      );
    } else if (tab === "duplicates" && input === "c" && props.onAsk)
      props.onAsk(CONSOLIDATE_PROMPT);
  });

  const memoryRows = (items: readonly MemoryHit[], scored: boolean): Row[] =>
    items.map((h) => ({
      id: h.id,
      cells: {
        title: h.title,
        labels: h.labels.join(", "),
        score: scored ? h.score.toFixed(2) : "",
      },
    }));
  const memoryColumns = (scored: boolean) => [
    { key: "title", title: "Memory", width: 50 },
    { key: "labels", title: "Kinds", width: 22 },
    ...(scored ? [{ key: "score", title: "Score", align: "right" as const }] : []),
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.memory} paddingX={1}>
      <Text wrap="truncate-end">
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
      <Text dimColor wrap="truncate-end">
        {MEMORY_WORDS}
      </Text>
      {error !== undefined && <Text color={theme.error}>✗ {error}</Text>}

      {tab === "browse" && (
        <>
          <Text wrap="truncate-end">
            <Text dimColor>kind: </Text>
            {["all", ...kinds].map((k, i) => (
              <Text
                key={k}
                {...(i === kind ? { color: theme.selected, bold: true } : { dimColor: true })}
              >
                {i === kind ? `[${k}]` : ` ${k} `}{" "}
              </Text>
            ))}
          </Text>
          {page === undefined ? (
            <Text dimColor>asking Grafeno…</Text>
          ) : (
            <Table
              columns={memoryColumns(false)}
              rows={memoryRows(page.items, false)}
              height={10}
              isActive={!busy}
              onOpen={openNode}
            />
          )}
          <Text dimColor wrap="truncate-end">
            in the order Grafeno keeps them (oldest first) · ←→ kind · enter open (then x forget)
            {page?.next ? " · n more" : ""} · tab next tab · esc close
          </Text>
        </>
      )}

      {tab === "search" && (
        <>
          <Prompt
            active={focus === "query" && !busy}
            commands={false}
            initial={query}
            placeholder="words to look for in the memory (part of a word is enough)"
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
              columns={memoryColumns(true)}
              rows={memoryRows(hits, true)}
              height={8}
              isActive={focus === "results" && !busy}
              onOpen={openNode}
            />
          )}
          <Text dimColor>
            {focus === "query" ? "enter search" : "enter open (then x forget) · / search again"} ·
            tab next tab · esc {focus === "results" ? "back" : "close"}
          </Text>
        </>
      )}

      {tab === "duplicates" && (
        <>
          {pairs === undefined ? (
            <Text dimColor>asking Grafeno…</Text>
          ) : pairs.length === 0 ? (
            <Text color={theme.success}>✓ Grafeno sees no duplicates.</Text>
          ) : (
            <Table
              columns={[
                { key: "a", title: "Memory", width: 36 },
                { key: "b", title: "Likely the same as", width: 36 },
                { key: "score", title: "Alike", align: "right" },
              ]}
              rows={pairs.map((p, i) => ({
                id: String(i),
                cells: { a: p.a.title, b: p.b.title, score: p.score.toFixed(2) },
              }))}
              height={8}
              isActive={!busy}
              onOpen={(id) => {
                setPair(pairs[Number(id)]);
              }}
            />
          )}
          <Text dimColor wrap="truncate-end">
            enter merge (choose which stays){lastMerge ? " · u undo the last merge" : ""}
            {props.onAsk ? " · c ask the agent to consolidate old memories" : ""} · tab next tab ·
            esc close
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
            enter inspect (empty or delete from there: the dialog shows the name to type) · tab next
            tab · esc close
          </Text>
        </>
      )}

      {node && !forgetting && (
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
          <Text dimColor>enter go to that memory · del or x forget this memory · esc back</Text>
        </Box>
      )}

      {node && forgetting && (
        <Dialog
          danger
          title={`Forget “${node.title}”?`}
          message="The memory and its facts are deleted from Grafeno for good (it keeps no copy). To say it is no longer true instead, ask the agent to revise it."
          confirmLabel="Forget it"
          cancelLabel="Keep it"
          onCancel={() => {
            setForgetting(false);
          }}
          onConfirm={() => {
            const gone = node;
            setForgetting(false);
            setNode(undefined);
            admin.forget(admin.active, gone.id).then(
              () => {
                props.notice(`Forgotten: ${gone.title}.`, "success");
                setHits((was) => was?.filter((h) => h.id !== gone.id));
                setPage((was) =>
                  was ? { ...was, items: was.items.filter((h) => h.id !== gone.id) } : was,
                );
              },
              (e: unknown) => {
                props.notice(`${gone.title}: ${message(e)}`, "error");
              },
            );
          }}
        />
      )}

      {pair && (
        <ContextMenu
          title={`Merge: which memory stays? (the other's facts move to it)`}
          items={[
            { id: "a", label: `Keep “${pair.a.title}”`, hint: `merge “${pair.b.title}” into it` },
            { id: "b", label: `Keep “${pair.b.title}”`, hint: `merge “${pair.a.title}” into it` },
            { id: "none", label: "Neither: they differ" },
          ]}
          onSelect={(id) => {
            const chosen = pair;
            setPair(undefined);
            if (id === "none") return;
            const [keep, merge] = id === "a" ? [chosen.a, chosen.b] : [chosen.b, chosen.a];
            admin.merge(admin.active, keep.id, merge.id).then(
              ({ undo }) => {
                setLastMerge(undo || undefined);
                props.notice(
                  `Merged “${merge.title}” into “${keep.title}”.${undo ? " u undoes it." : ""}`,
                  "success",
                );
                loadPairs();
              },
              (e: unknown) => {
                props.notice(message(e), "error");
              },
            );
          }}
          onClose={() => {
            setPair(undefined);
          }}
        />
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
