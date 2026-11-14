/**
 * Turns text into vectors of meaning, so memory can be searched by what
 * it says and not only by its words. Nothing outside `src/embed` knows
 * which model does it.
 */
export interface Embedder {
  /** Its name, such as `e5-small`. */
  readonly name: string;
  /** Numbers in each vector. */
  readonly dimension: number;
  /**
   * Vectors for texts, in order. A `query` is something asked; a `passage`
   * is something stored. Some models embed them differently.
   */
  embed(texts: readonly string[], kind: "query" | "passage"): Promise<number[][]>;
}
