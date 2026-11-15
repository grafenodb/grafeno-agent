import { estimateTokens } from "./resume.js";
import type { VaultAnswer } from "./vault.js";

/**
 * The Memory Retrieval Budget Manager: how much memory reaches the model.
 *
 * Two kinds of limit, kept apart:
 *
 * - **Hard limits** keep the session safe, and are never passed:
 *   `resultChars` (the largest answer a lookup may put into the context;
 *   longer ones are cut at a line, with what was left out named by id) and
 *   `callsPerTurn` (lookups a model may make in one turn).
 * - **Soft budgets** keep quality, and say what they hold back:
 *   `lookupTokens` and `lookupItems` (what each lookup asks Grafeno for,
 *   unless the model asks for less), and `sessionTokens` (memory brought in
 *   on its own, before messages; once used up, nothing more comes on its
 *   own, but the model may still look things up when it needs them).
 *
 * What memory already showed this session is not shown again in full: a
 * memory seen before comes back as its id and name, "shown earlier".
 */

export interface RetrievalLimits {
  /** Tokens for the checkpoint, in a compact resume. */
  readonly checkpoint: number;
  /** Tokens for the related memories, in a compact resume. */
  readonly memories: number;
  /** Related memories at most, in a compact resume. */
  readonly maxMemories: number;
  /** Tokens each lookup asks for (soft). */
  readonly lookupTokens: number;
  /** Items each lookup asks for at most (soft). */
  readonly lookupItems: number;
  /** The longest answer a lookup may put into the context, in characters (hard). */
  readonly resultChars: number;
  /** Lookups in one turn (hard). */
  readonly callsPerTurn: number;
  /** Tokens of memory brought in on its own over a session (soft). */
  readonly sessionTokens: number;
}

export const DEFAULT_LIMITS: RetrievalLimits = {
  checkpoint: 500,
  memories: 500,
  maxMemories: 5,
  lookupTokens: 800,
  lookupItems: 8,
  resultChars: 12_000,
  callsPerTurn: 8,
  sessionTokens: 20_000,
};

/** The names `AGENT_MEMORY_BUDGET` takes, as `checkpoint=400,session=10000`. */
export const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as (keyof RetrievalLimits)[];

/** Reads `name=value,…`; unknown names and bad values are problems. */
export function parseLimits(text: string): {
  limits: Partial<RetrievalLimits>;
  problems: string[];
} {
  const limits: Partial<Record<keyof RetrievalLimits, number>> = {};
  const problems: string[] = [];
  for (const part of text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [name, raw] = part.split("=").map((p) => p.trim());
    const value = Number(raw);
    if (!name || !(LIMIT_NAMES as string[]).includes(name)) {
      problems.push(
        `AGENT_MEMORY_BUDGET: unknown limit "${name ?? part}" (${LIMIT_NAMES.join(", ")})`,
      );
    } else if (!Number.isInteger(value) || value < 0) {
      problems.push(
        `AGENT_MEMORY_BUDGET: ${name} must be a whole number of 0 or more: ${raw ?? ""}`,
      );
    } else {
      limits[name as keyof RetrievalLimits] = value;
    }
  }
  return { limits, problems };
}

/** How a memory tool reads memory, for its budget. */
type Kind = "lookup" | "deep" | "other";

/** Lookups: what the model asks memory for. */
const LOOKUPS = new Set([
  "recall",
  "context",
  "get_node",
  "find_matches",
  "contradictions",
  "palace_reflect",
]);

/**
 * Deep exploration (level 3): walking the palace. Never part of starting a
 * session; allowed when the work needs it, one per turn and within the hard
 * size limit, and named as such to the model.
 */
const DEEP = new Set(["palace_map", "palace_enter", "palace_walk", "timeline"]);

export interface RetrievalStats {
  /** Lookups the model made, and deep ones among them. */
  readonly calls: number;
  readonly deepCalls: number;
  /** Lookups refused for the hard limit of a turn. */
  readonly refused: number;
  /** Lookups made on their own (before messages), and those skipped for the session's budget. */
  readonly automatic: number;
  readonly automaticSkipped: number;
  /** Estimated tokens memory put into the context, all told and on its own. */
  readonly tokens: number;
  readonly automaticTokens: number;
  readonly itemsReturned: number;
  readonly itemsDeduplicated: number;
  /** Answers cut for the hard size limit. */
  readonly cut: number;
}

export class RetrievalBudget {
  readonly limits: RetrievalLimits;
  readonly #seen = new Set<string>();
  #turnCalls = 0;
  #turnDeep = 0;
  #stats = {
    calls: 0,
    deepCalls: 0,
    refused: 0,
    automatic: 0,
    automaticSkipped: 0,
    tokens: 0,
    automaticTokens: 0,
    itemsReturned: 0,
    itemsDeduplicated: 0,
    cut: 0,
  };

  constructor(limits: Partial<RetrievalLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get stats(): RetrievalStats {
    return { ...this.#stats };
  }

  /**
   * A new conversation: nothing is in its context yet, so nothing was
   * "shown earlier", and memory may come on its own again. What was spent
   * stays counted in the stats.
   */
  reset(): void {
    this.#seen.clear();
    this.#turnCalls = 0;
    this.#turnDeep = 0;
    this.#stats.automaticTokens = 0;
  }

  /** A new turn: the per-turn limit starts again. */
  startTurn(): void {
    this.#turnCalls = 0;
    this.#turnDeep = 0;
  }

  /** Marks memories as already in the context (the resume's), so they are not shown again. */
  seen(ids: Iterable<string>): void {
    for (const id of ids) this.#seen.add(id);
  }

  /** May memory still be brought in on its own (before a message)? */
  automaticAllowed(): boolean {
    if (this.#stats.automaticTokens < this.limits.sessionTokens) return true;
    this.#stats.automaticSkipped++;
    return false;
  }

  /** Counts what was brought in on its own. */
  countAutomatic(text: string): void {
    const tokens = estimateTokens(text);
    this.#stats.automatic++;
    this.#stats.automaticTokens += tokens;
    this.#stats.tokens += tokens;
  }

  /**
   * Before a memory tool runs: a refusal (the hard limit of a turn), or the
   * arguments with the soft budgets applied where the model did not ask for
   * less.
   */
  admit(
    tool: string,
    args: Record<string, unknown>,
  ): { refused: string } | { args: Record<string, unknown> } {
    const kind = kindOf(tool);
    if (kind === "other") return { args };
    if (this.#turnCalls >= this.limits.callsPerTurn) {
      this.#stats.refused++;
      return {
        refused: `Memory lookup budget for this turn is used (${String(this.limits.callsPerTurn)} lookups). Work with what you have, or ask the user before looking further.`,
      };
    }
    if (kind === "deep" && this.#turnDeep >= 1) {
      this.#stats.refused++;
      return {
        refused: `One deep look at the palace per turn (${tool}): use recall or get_node for something specific.`,
      };
    }
    this.#turnCalls++;
    this.#stats.calls++;
    if (kind === "deep") {
      this.#turnDeep++;
      this.#stats.deepCalls++;
    }
    const shaped = { ...args };
    const { lookupItems, lookupTokens } = this.limits;
    if (tool === "recall" || tool === "find_matches") {
      shaped.limit = Math.min(positive(args.limit) ?? lookupItems, lookupItems);
    }
    if (tool === "context" || tool === "palace_enter") {
      shaped.budget = Math.min(positive(args.budget) ?? lookupTokens, lookupTokens);
    }
    return { args: shaped };
  }

  /**
   * What a memory tool answered, made fit for the context: a search's
   * results as compact lines (memories shown earlier this session by id
   * only), any other structured answer as compact JSON, and anything longer
   * than the hard limit cut at a line, with the ids it left out named.
   */
  fit(tool: string, answer: VaultAnswer): string {
    if (answer.isError || kindOf(tool) === "other") return answer.text;
    let text = answer.text;
    const results = searchResults(answer);
    if (results !== undefined) {
      text = this.#renderResults(results);
    } else if (answer.data !== undefined && looksLikeJson(answer.text)) {
      text = JSON.stringify(answer.data);
    }
    text = this.#cut(text);
    this.#stats.tokens += estimateTokens(text);
    return text;
  }

  #renderResults(results: SearchResult[]): string {
    if (results.length === 0) return "No memories found.";
    const lines: string[] = [];
    for (const r of results) {
      const head = `[${r.id}]${r.name ? ` ${r.name}` : ""}${r.labels.length > 0 ? ` (${r.labels.join(", ")})` : ""}`;
      if (this.#seen.has(r.id)) {
        this.#stats.itemsDeduplicated++;
        lines.push(`${head}: shown earlier this session`);
        continue;
      }
      this.#seen.add(r.id);
      this.#stats.itemsReturned++;
      const text =
        r.name && r.text.startsWith(`${r.name}: `) ? r.text.slice(r.name.length + 2) : r.text;
      lines.push(`${head}: ${text.replace(/\s+/g, " ").trim()}`);
    }
    return lines.join("\n");
  }

  #cut(text: string): string {
    const max = this.limits.resultChars;
    if (text.length <= max) return text;
    this.#stats.cut++;
    const head = text.slice(0, max);
    const at = head.lastIndexOf("\n");
    const kept = at > max / 2 ? head.slice(0, at) : head;
    const rest = text.slice(kept.length);
    const ids = [
      ...new Set(rest.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []),
    ];
    const named =
      ids.length > 0
        ? ` Left out, by id: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ` and ${String(ids.length - 20)} more` : ""}.`
        : "";
    return `${kept}\n(cut at ${String(max)} characters: ${String(rest.length)} more.${named} Ask more narrowly, or get_node an id.)`;
  }
}

interface SearchResult {
  readonly id: string;
  readonly name?: string;
  readonly labels: string[];
  readonly text: string;
}

/** A search's results (`recall`, `find_matches`), when the answer has them. */
function searchResults(answer: VaultAnswer): SearchResult[] | undefined {
  const data = answer.data as { results?: unknown } | undefined;
  if (!data || !Array.isArray(data.results)) return undefined;
  const out: SearchResult[] = [];
  for (const item of data.results) {
    const node = item as { id?: unknown; name?: unknown; labels?: unknown; text?: unknown };
    if (typeof node.id !== "string") return undefined;
    out.push({
      id: node.id,
      ...(typeof node.name === "string" && node.name !== "" ? { name: node.name } : {}),
      labels: Array.isArray(node.labels) ? node.labels.map(String) : [],
      text: typeof node.text === "string" ? node.text : "",
    });
  }
  return out;
}

function kindOf(tool: string): Kind {
  if (LOOKUPS.has(tool)) return "lookup";
  if (DEEP.has(tool)) return "deep";
  return "other";
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}
