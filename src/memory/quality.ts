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
