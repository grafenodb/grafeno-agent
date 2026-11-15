import { readCheckpoint, type StructuredCheckpoint } from "./checkpoint.js";
import { normalize, similarity, SAME } from "./quality.js";
import type { Vault, VaultAnswer } from "./vault.js";

/**
 * Compact Resume: what a new session needs to go on, and nothing more.
 *
 * It is built by code, without the model: the latest checkpoint (and, with
 * several agents, the project's newer one by another), then a few memories
 * about the task's goal and next action, each within a budget of tokens.
 * Memories past the budget are not dropped silently: they are listed by id,
 * to be looked up (`get_node`, `recall`) only when needed. The palace is not
 * walked, and earlier conversations are not brought back.
 */

export interface CompactResumeOptions {
  readonly vault: Vault;
  /** The node the checkpoints are about (the project's), when they have one. */
  readonly about?: string;
  /** The task, when its checkpoints are filed by task (not about a node). */
  readonly task?: string;
  /** This agent's name: its own checkpoint first, and another's newer one noted. */
  readonly agent?: string;
  /** Tokens for the checkpoint. Default: 500. */
  readonly checkpointBudget?: number;
  /** Tokens for the related memories. Default: 500. */
  readonly memoryBudget?: number;
  /** At most this many related memories. Default: 5. */
  readonly maxMemories?: number;
  /** What to look memories up by; default: the task's goal and next action. */
  readonly query?: string;
  /** The vector of the query, when there is an embedder. */
  readonly embed?: (text: string) => Promise<number[] | undefined>;
}

export interface ResumeMemory {
  readonly id: string;
  readonly name?: string;
  readonly text: string;
}

export interface ResumeStats {
  /** Calls to Grafeno. */
  readonly calls: number;
  readonly durationMs: number;
  readonly checkpointTokens: number;
  readonly memoryTokens: number;
  readonly totalTokens: number;
  readonly itemsReturned: number;
  readonly itemsDeduplicated: number;
  /** Memories past the budget, listed by id instead. */
  readonly itemsLeftOut: number;
  /** Items of the checkpoint's lists cut for its budget (never the next action, blocks or errors). */
  readonly checkpointItemsCut: number;
}

export interface CompactResume {
  readonly checkpoint?: StructuredCheckpoint;
  /** The project's newer checkpoint, saved by another agent. */
  readonly other?: StructuredCheckpoint;
  readonly memories: readonly ResumeMemory[];
  /** Memories not included, to look up by id when needed. */
  readonly more: readonly ResumeMemory[];
  /** The state, as compact text for the model. */
  readonly text: string;
  readonly stats: ResumeStats;
  /** Grafeno could not be reached or refused: the text says so. */
  readonly unavailable?: string;
}

/** Tokens of a text, estimated (about four characters each). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Labels of nodes that are not memories to bring back as such. */
const NOT_MEMORIES = new Set(["Checkpoint", "Project", "Agent", "Room", "Palace", "Locus"]);

/** Memories scoring below this share of the best match are not brought. */
const RELEVANCE_FLOOR = 0.5;

/** The most ids listed past the budget. */
const MORE_LIMIT = 10;

/** The longest a single item may be, in characters, before it is cut. */
const ITEM_CHARS = 280;

export async function compactResume(options: CompactResumeOptions): Promise<CompactResume> {
  const started = Date.now();
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<VaultAnswer> => {
    calls++;
    return options.vault.call(name, args);
  };

  let checkpoint: StructuredCheckpoint | undefined;
  let other: StructuredCheckpoint | undefined;
  let fallback: string | undefined;
  try {
    const base: Record<string, unknown> = {
      ...(options.about ? { about: options.about } : {}),
      ...(options.task ? { task: options.task } : {}),
    };
    const latest = await resumeOf(call, base);
    const mine =
      options.agent === undefined
        ? latest
        : latest === undefined
          ? undefined // No checkpoint at all: none of this agent's either.
          : await resumeOf(call, { ...base, agent: options.agent });
    checkpoint = mine?.checkpoint;
    fallback = mine && !mine.checkpoint ? mine.text : undefined;
    if (
      options.agent !== undefined &&
      latest?.checkpoint &&
      latest.checkpoint.id !== checkpoint?.id
    ) {
      other = latest.checkpoint;
    }
  } catch (error) {
    return unavailable(error, calls, started);
  }

  // Related memories: by the goal and the next action, never the whole palace.
  const maxMemories = options.maxMemories ?? 5;
  const query =
    options.query ??
    [checkpoint?.task.goal, checkpoint?.task.nextAction, checkpoint?.task.id]
      .filter(Boolean)
      .join(" — ");
  let found: ResumeMemory[] = [];
  let deduplicated = 0;
  if (query.trim() !== "" && maxMemories > 0) {
    try {
      const embedding = await options.embed?.(query);
      const answer = await call("recall", {
        query,
        limit: maxMemories * 3,
        depth: 0,
        ...(embedding ? { embedding } : {}),
      });
      if (!answer.isError) {
        const picked = pickMemories(answer, checkpoint);
        found = picked.memories;
        deduplicated = picked.deduplicated;
      }
    } catch {
      // Memories are extra: the checkpoint alone still lets the work go on.
    }
  }

  // Memories the checkpoint points at come first, when the search found them.
  const refs = new Set(checkpoint?.memoryRefs ?? []);
  found.sort((a, b) => Number(refs.has(b.id)) - Number(refs.has(a.id)));

  const checkpointPart = renderCheckpoint(
    checkpoint,
    other,
    fallback,
    options.checkpointBudget ?? 500,
  );
  const memoryBudget = options.memoryBudget ?? 500;
  const memories: ResumeMemory[] = [];
  const more: ResumeMemory[] = [];
  let memoryText = "";
  for (const memory of found) {
    const line = `- ${memory.name ? `${memory.name} ` : ""}[${memory.id}]: ${memory.text}`;
    if (memories.length < maxMemories && estimateTokens(memoryText + line) <= memoryBudget) {
      memories.push(memory);
      memoryText += `${line}\n`;
    } else {
      more.push(memory);
    }
  }
  // Refs of the checkpoint that the search did not bring: listed, not fetched.
  for (const id of refs) {
    if (!memories.some((m) => m.id === id) && !more.some((m) => m.id === id)) {
      more.push({ id, text: "" });
    }
  }

  const parts = [checkpointPart.text];
  if (memories.length > 0) parts.push(`## Related memories\n${memoryText.trimEnd()}`);
  if (more.length > 0) {
    const listed = more
      .slice(0, MORE_LIMIT)
      .map((m) => (m.name ? `${m.id} (${m.name})` : m.id))
      .join("; ");
    const extra = more.length > MORE_LIMIT ? ` and ${String(more.length - MORE_LIMIT)} more` : "";
    parts.push(`More in memory, not loaded (get_node or recall when needed): ${listed}${extra}`);
  }
  const text = parts.join("\n\n");
  const checkpointTokens = estimateTokens(checkpointPart.text);
  const memoryTokens = estimateTokens(memoryText);
  return {
    ...(checkpoint ? { checkpoint } : {}),
    ...(other ? { other } : {}),
    memories,
    more,
    text,
    stats: {
      calls,
      durationMs: Date.now() - started,
      checkpointTokens,
      memoryTokens,
      totalTokens: estimateTokens(text),
      itemsReturned: memories.length,
      itemsDeduplicated: deduplicated,
      itemsLeftOut: more.length,
      checkpointItemsCut: checkpointPart.cut,
    },
  };
}

interface Resumed {
  readonly checkpoint?: StructuredCheckpoint;
  readonly text: string;
}

async function resumeOf(
  call: (name: string, args: Record<string, unknown>) => Promise<VaultAnswer>,
  args: Record<string, unknown>,
): Promise<Resumed | undefined> {
  const answer = await call("resume", args);
  if (answer.isError) throw new Error(answer.text);
  const data = (answer.data ?? parse(answer.text)) as
    { found?: boolean; checkpoint?: unknown } | undefined;
  if (data?.found === false) return undefined;
  const checkpoint = readCheckpoint(data?.checkpoint);
  return { ...(checkpoint ? { checkpoint } : {}), text: answer.text };
}

/** The memories of a `recall`, without checkpoints and the like, and without repeats. */
function pickMemories(
  answer: VaultAnswer,
  checkpoint: StructuredCheckpoint | undefined,
): { memories: ResumeMemory[]; deduplicated: number } {
  const data = (answer.data ?? parse(answer.text)) as { results?: unknown[] } | undefined;
  const memories: ResumeMemory[] = [];
  let deduplicated = 0;
  // What the checkpoint already says is not said again.
  const said = checkpoint
    ? [...checkpoint.decisions, checkpoint.summary, ...checkpoint.progress.completed]
    : [];
  // Only what is close to the best match: a weak match costs tokens and
  // helps little (the search's scores, when it gives them).
  const results = data?.results ?? [];
  const scores = results
    .map((item) => (item as { score?: unknown }).score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const floor = scores.length > 0 ? Math.max(...scores) * RELEVANCE_FLOOR : -Infinity;
  for (const item of results) {
    const node = item as {
      id?: unknown;
      name?: unknown;
      text?: unknown;
      labels?: unknown;
      score?: unknown;
    };
    if (typeof node.id !== "string") continue;
    if (typeof node.score === "number" && node.score < floor) continue;
    const labels = Array.isArray(node.labels) ? node.labels.map(String) : [];
    if (labels.some((label) => NOT_MEMORIES.has(label))) continue;
    const name = typeof node.name === "string" && node.name !== "" ? node.name : undefined;
    const text = withoutName(typeof node.text === "string" ? node.text : "", name);
    if (text === "") continue;
    const repeated =
      memories.some((m) => m.id === node.id || similarity(m.text, text) >= SAME) ||
      said.some((line) => similarity(line, text) >= SAME);
    if (repeated) {
      deduplicated++;
      continue;
    }
    memories.push({ id: node.id, ...(name ? { name } : {}), text: cut(text, ITEM_CHARS) });
  }
  return { memories, deduplicated };
}

/** Grafeno puts a memory's name in front of its text: once is enough. */
function withoutName(text: string, name: string | undefined): string {
  const trimmed = text.trim();
  if (name && normalize(trimmed).startsWith(normalize(name))) {
    const rest = trimmed.slice(name.length).replace(/^\s*[:—-]\s*/, "");
    return rest.trim() === "" ? trimmed : rest.trim();
  }
  return trimmed;
}

/**
 * The checkpoint as compact text, within its budget. What the work cannot
 * go on without (the task, the next action, what is blocked, the errors) is
 * always there, each item cut to a sensible length; the rest is added in
 * order of use while the budget lasts, and what is cut is counted and said.
 */
function renderCheckpoint(
  checkpoint: StructuredCheckpoint | undefined,
  other: StructuredCheckpoint | undefined,
  fallback: string | undefined,
  budget: number,
): { text: string; cut: number } {
  if (!checkpoint) {
    if (fallback !== undefined && fallback.trim() !== "") {
      const text = `## Where the work stands\n${cut(fallback.trim(), budget * 4)}`;
      return { text: withOther(text, other), cut: 0 };
    }
    const none =
      "## Where the work stands\nNo checkpoint was saved yet: this is the first session.";
    return { text: withOther(none, other), cut: 0 };
  }
  const { task } = checkpoint;
  const head = [
    `## Where the work stands (compact resume)`,
    `Task: ${task.id}${task.goal ? ` — ${cut(task.goal, ITEM_CHARS)}` : ""} [${task.status}]`,
    `Saved: ${[
      checkpoint.id ? `checkpoint ${checkpoint.id}` : undefined,
      checkpoint.agent ? `by ${checkpoint.agent}` : undefined,
      checkpoint.updatedAt
        ? checkpoint.updatedAt.toISOString().slice(0, 16).replace("T", " ")
        : undefined,
      checkpoint.gitRef ? `git ${checkpoint.gitRef}` : undefined,
    ]
      .filter(Boolean)
      .join(", ")}`,
  ];
  if (task.nextAction) head.push(`Next: ${cut(task.nextAction, ITEM_CHARS * 2)}`);
  if (checkpoint.progress.blocked.length > 0) {
    head.push(`Blocked: ${checkpoint.progress.blocked.map((b) => cut(b, ITEM_CHARS)).join("; ")}`);
  }
  if (checkpoint.errors.length > 0) {
    head.push(`Open errors: ${checkpoint.errors.map((e) => cut(e, ITEM_CHARS)).join("; ")}`);
  }

  let text = head.join("\n");
  let cutCount = 0;
  const room = () => budget * 4 - text.length;
  const section = (title: string, items: readonly string[], latestFirst = false) => {
    if (items.length === 0) return;
    const ordered = latestFirst ? [...items].reverse() : [...items];
    const kept: string[] = [];
    for (const item of ordered) {
      const line = `- ${cut(item, ITEM_CHARS)}`;
      if (room() - (title.length + 2) - kept.join("\n").length - line.length - 1 < 0) break;
      kept.push(line);
    }
    const dropped = items.length - kept.length;
    cutCount += dropped;
    if (kept.length === 0) {
      text += `\n${title}: ${String(items.length)} (in the checkpoint)`;
      return;
    }
    const tail = dropped > 0 ? `\n- (+${String(dropped)} more in the checkpoint)` : "";
    text += `\n${title}:\n${kept.join("\n")}${tail}`;
  };
  if (checkpoint.summary !== "") {
    const summary = cut(checkpoint.summary, Math.max(120, Math.min(600, room() / 2)));
    text += `\nSummary: ${summary}`;
  }
  section("Pending", checkpoint.progress.pending);
  section("Decisions", checkpoint.decisions);
  section("Files", checkpoint.files);
  section("Done (latest first)", checkpoint.progress.completed, true);
  return { text: withOther(text, other), cut: cutCount };
}

function withOther(text: string, other: StructuredCheckpoint | undefined): string {
  if (!other) return text;
  const when = other.updatedAt
    ? `, ${other.updatedAt.toISOString().slice(0, 16).replace("T", " ")}`
    : "";
  const next = other.task.nextAction ? ` Next: ${cut(other.task.nextAction, ITEM_CHARS)}` : "";
  return `${text}\n\nNewer checkpoint by another agent (${other.agent ?? "unknown"}${when}), its work, not yours to redo: ${cut(other.summary, ITEM_CHARS)}${next}`;
}

function unavailable(error: unknown, calls: number, started: number): CompactResume {
  const reason = error instanceof Error ? error.message : String(error);
  const text = `## Where the work stands\nMemory could not be reached (${cut(reason, 160)}): no checkpoint was loaded. Check memory before relying on earlier work.`;
  return {
    memories: [],
    more: [],
    text,
    unavailable: reason,
    stats: {
      calls,
      durationMs: Date.now() - started,
      checkpointTokens: estimateTokens(text),
      memoryTokens: 0,
      totalTokens: estimateTokens(text),
      itemsReturned: 0,
      itemsDeduplicated: 0,
      itemsLeftOut: 0,
      checkpointItemsCut: 0,
    },
  };
}

function cut(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, Math.max(1, chars - 1)).trimEnd()}…`;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
