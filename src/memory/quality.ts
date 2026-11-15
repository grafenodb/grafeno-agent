import type { Embedder } from "../embed/types.js";
import type { Vault } from "./vault.js";

/** Lower case, words only, single spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How alike two texts are by their words, from 0 to 1 (Jaccard). */
export function similarity(a: string, b: string): number {
  const left = new Set(normalize(a).split(" ").filter(Boolean));
  const right = new Set(normalize(b).split(" ").filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

export interface KnownMemory {
  readonly id: string;
  readonly name?: string;
  readonly text: string;
}

/** Texts at least this alike are the same memory. */
export const SAME = 0.8;

/**
 * Looks in memory for one that says the same as `text`, before storing it
 * again. Grafeno keeps two memories of the same words apart unless they
 * share a name; meaning (embeddings) is not compared here.
 */
export async function findDuplicate(
  vault: Vault,
  text: string,
  name?: string,
): Promise<KnownMemory | undefined> {
  const answer = await vault.call("recall", { query: text, limit: 5, depth: 0 });
  if (answer.isError) return undefined;
  let results: unknown;
  try {
    results = (answer.data ?? JSON.parse(answer.text)) as unknown;
  } catch {
    return undefined;
  }
  const list = (results as { results?: unknown[] } | undefined)?.results ?? [];
  for (const item of list) {
    const memory = item as { id?: unknown; name?: unknown; text?: unknown };
    if (typeof memory.id !== "string" || typeof memory.text !== "string") continue;
    const memoryName = typeof memory.name === "string" ? memory.name : undefined;
    // The same name is Grafeno's own way to update a memory: let it.
    if (
      name !== undefined &&
      memoryName !== undefined &&
      normalize(name) === normalize(memoryName)
    ) {
      return undefined;
    }
    // Grafeno keeps a named memory's text as "<name>: <text>".
    const prefix = memoryName === undefined ? "" : `${memoryName}: `;
    const own =
      prefix !== "" && memory.text.startsWith(prefix)
        ? memory.text.slice(prefix.length)
        : memory.text;
    if (similarity(text, own) >= SAME || similarity(text, memory.text) >= SAME) {
      return {
        id: memory.id,
        text: memory.text,
        ...(memoryName === undefined ? {} : { name: memoryName }),
      };
    }
  }
  return undefined;
}

/**
 * Meaning this close (cosine, e5-small) is worth a word to the model before
 * storing. Measured (docs/memory-retrieval.md, stage 4): the same fact
 * reworded scored 0.887–0.979, a fact that changed 0.940–0.943, related but
 * different facts 0.848, unrelated 0.776. Meaning cannot tell "the same"
 * from "changed", so a close memory is never refused on meaning alone: the
 * model is told, and chooses (revise it, leave it, or store it as distinct).
 */
export const CLOSE = 0.93;

/** Labels of nodes that are not memories to compare with. */
const NOT_MEMORIES = new Set(["Checkpoint", "Project", "Agent"]);

/**
 * A memory close in meaning to `text`, found with its vector, when there is
 * one at or above `CLOSE`. Undefined when nothing is close or meaning is not
 * available.
 */
export async function findClose(
  vault: Vault,
  embedder: Pick<Embedder, "embed">,
  text: string,
  embedding: readonly number[],
): Promise<(KnownMemory & { closeness: number }) | undefined> {
  const answer = await vault.call("recall", {
    query: text,
    embedding: [...embedding],
    limit: 3,
    depth: 0,
  });
  if (answer.isError) return undefined;
  const list = ((answer.data ?? safeParse(answer.text)) as { results?: unknown[] } | undefined)
    ?.results;
  const candidates: KnownMemory[] = [];
  for (const item of list ?? []) {
    const memory = item as { id?: unknown; name?: unknown; text?: unknown; labels?: unknown };
    if (typeof memory.id !== "string" || typeof memory.text !== "string") continue;
    const labels = Array.isArray(memory.labels) ? memory.labels.map(String) : [];
    if (labels.some((label) => NOT_MEMORIES.has(label))) continue;
    candidates.push({
      id: memory.id,
      text: memory.text,
      ...(typeof memory.name === "string" ? { name: memory.name } : {}),
    });
  }
  if (candidates.length === 0) return undefined;
  const vectors = await embedder.embed(
    candidates.map((c) => c.text),
    "passage",
  );
  let best: (KnownMemory & { closeness: number }) | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    const closeness = cosine(embedding, vector);
    if (closeness >= CLOSE && (best === undefined || closeness > best.closeness)) {
      best = { ...candidate, closeness };
    }
  }
  return best;
}

/** How alike two vectors point, from -1 to 1. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
