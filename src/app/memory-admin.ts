import type {
  ConstraintEvent,
  Grafeno,
  NamespaceInfo,
  NamespaceStats,
  NodeWithText,
} from "@grafenodb/client";

/** A memory found, as a row: what it is called, its kinds and how well it matched. */
export interface MemoryHit {
  readonly id: string;
  readonly title: string;
  readonly labels: readonly string[];
  readonly score: number;
}

/** Two memories Grafeno takes for the same one. */
export interface Duplicate {
  readonly a: { readonly id: string; readonly title: string };
  readonly b: { readonly id: string; readonly title: string };
  readonly score: number;
}

/** A fact that joins a memory to another one. */
export interface MemoryRelation {
  readonly label: string;
  /** Whether the fact goes from this memory, or comes to it. */
  readonly direction: "out" | "in";
  readonly other: { readonly id: string; readonly title: string };
  /** When the fact stopped holding (an invalidated fact keeps its history). */
  readonly ended: boolean;
}

/**
 * The memory as the interface shows it: what Grafeno exposes, nothing it
 * does not (no operation is made up here). Deleting or emptying a namespace
 * needs the `Drop` permission on it; without it the server says so, and
 * that is what is shown.
 */
export interface MemoryAdmin {
  /** The namespace this session's memory lives in. */
  readonly active: string;
  namespaces(): Promise<NamespaceInfo[]>;
  stats(namespace: string): Promise<NamespaceStats>;
  search(namespace: string, query: string): Promise<MemoryHit[]>;
  node(
    namespace: string,
    id: string,
  ): Promise<{ readonly node: NodeWithText; readonly relations: readonly MemoryRelation[] }>;
  contradictions(namespace: string): Promise<ConstraintEvent[]>;
  /** Memories in the order Grafeno keeps them (oldest first), a page at a time; of a kind, or all. */
  list(
    namespace: string,
    options?: { readonly kind?: string; readonly after?: string },
  ): Promise<{ readonly items: readonly MemoryHit[]; readonly next: string | null }>;
  /** Forgets a memory: it and its facts are deleted (Grafeno's forget on a memory). */
  forget(namespace: string, id: string): Promise<void>;
  /** The memories Grafeno takes for the same one, in pairs, with how alike they are. */
  duplicates(namespace: string): Promise<readonly Duplicate[]>;
  /** Merges one memory into another (its facts move to it); says how to undo it. */
  merge(namespace: string, keep: string, merge: string): Promise<{ readonly undo: string }>;
  undoMerge(namespace: string, undo: string): Promise<void>;
  /** Deletes a namespace and everything in it. */
  drop(namespace: string): Promise<void>;
  /**
   * Empties a namespace: Grafeno has no call for it, so it is deleted and
   * made again with the same description (not in one step: a failure in
   * between leaves it deleted, said as such).
   */
  empty(namespace: string): Promise<void>;
}

/** What a memory is called: its name, title or the start of its text, else its id. */
export function memoryTitle(node: {
  readonly props: Record<string, unknown>;
  readonly text?: string;
  readonly id: string;
}): string {
  for (const key of ["name", "title", "label"]) {
    const value = node.props[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const text = node.text ?? (typeof node.props.text === "string" ? node.props.text : undefined);
  if (text !== undefined && text.trim() !== "") {
    const line = text.trim().split("\n")[0] ?? "";
    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  }
  return node.id;
}

/** The memory, through a Grafeno client whose token may read it (and drop it, to delete). */
interface Named {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly text?: string;
}

const named = (n: Named) => ({
  id: n.id ?? "",
  title: n.name ?? n.title ?? (n.text ? n.text.slice(0, 70) : (n.id ?? "")),
});

export function memoryAdmin(client: Grafeno, active: string): MemoryAdmin {
  /** One of Grafeno's memory tools; its refusal is thrown with its own words. */
  const tool = async (namespace: string, name: string, args: Record<string, unknown>) => {
    const result = await client.namespace(namespace).callTool(name, args);
    if (result.isError) {
      throw new Error(result.content.map((part) => part.text).join(" ") || `${name} was refused`);
    }
    return result.structuredContent ?? {};
  };
  const titles = async (namespace: string, ids: readonly string[]) => {
    if (ids.length === 0) return new Map<string, string>();
    const read = await client
      .namespace(namespace)
      .readMany({ nodes: [...new Set(ids)].slice(0, 512) });
    const found = new Map<string, string>();
    for (const node of read.nodes) if (node) found.set(node.id, memoryTitle(node));
    return found;
  };
  return {
    active,
    namespaces: () => client.namespaces(),
    stats: (namespace) => client.namespace(namespace).stats(),
    async search(namespace, query) {
      const hits = await client.namespace(namespace).searchText(query, { limit: 30 });
      const read = await client
        .namespace(namespace)
        .readMany({ nodes: hits.map((h) => h.node).slice(0, 512) });
      return hits.map((hit, i) => {
        const node = read.nodes[i];
        return {
          id: hit.node,
          title: node ? memoryTitle(node) : hit.node,
          labels: node?.labels ?? [],
          score: hit.score,
        };
      });
    },
    async node(namespace, id) {
      const space = client.namespace(namespace);
      const [node, out, incoming] = await Promise.all([
        space.getNode(id),
        space.neighbors(id, { direction: "out" }),
        space.neighbors(id, { direction: "in" }),
      ]);
      const named = await titles(
        namespace,
        [...out, ...incoming].map((n) => n.node),
      );
      const relation = (direction: "out" | "in") => (n: (typeof out)[number]) => ({
        label: n.edge.label,
        direction,
        other: { id: n.node, title: named.get(n.node) ?? n.node },
        ended: n.edge.valid_to !== null || n.edge.expired_at !== null,
      });
      return { node, relations: [...out.map(relation("out")), ...incoming.map(relation("in"))] };
    },
    contradictions: (namespace) => client.namespace(namespace).contradictions({ limit: 50 }),
    async list(namespace, options = {}) {
      const page = await client.namespace(namespace).listNodes({
        limit: 50,
        ...(options.kind ? { label: options.kind } : {}),
        ...(options.after ? { after: options.after } : {}),
      });
      return {
        items: page.items.map((node) => ({
          id: node.id,
          title: memoryTitle(node),
          labels: node.labels,
          score: 0,
        })),
        next: page.next,
      };
    },
    async forget(namespace, id) {
      await tool(namespace, "forget", { id });
    },
    async duplicates(namespace) {
      const report = (await tool(namespace, "maintain", { limit: 50 })) as {
        duplicates?: { a?: Named; b?: Named; score?: number }[];
      };
      return (report.duplicates ?? []).flatMap((d) =>
        d.a?.id && d.b?.id
          ? [{ a: named(d.a), b: named(d.b), score: typeof d.score === "number" ? d.score : 0 }]
          : [],
      );
    },
    async merge(namespace, keep, merge) {
      const done = (await tool(namespace, "merge", { keep, merge })) as { merge_id?: string };
      return { undo: done.merge_id ?? "" };
    },
    async undoMerge(namespace, undo) {
      await tool(namespace, "undo_merge", { merge_id: undo });
    },
    async drop(namespace) {
      await client.dropNamespace(namespace);
    },
    async empty(namespace) {
      const info = await client.getNamespace(namespace);
      await client.dropNamespace(namespace);
      try {
        await client.createNamespace(namespace, info.description);
      } catch (error) {
        throw new Error(
          `${namespace} was deleted but could not be made again: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  };
}
