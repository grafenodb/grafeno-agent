import type { Vault } from "./vault.js";

/** One thing upkeep found, and what was done about it. */
export interface UpkeepItem {
  readonly kind: string;
  /** What it is, in a sentence. */
  readonly what: string;
  /** Why it matters, or why it was changed. */
  readonly why: string;
  /** What was done; absent when it was only reported. */
  readonly done?: string;
}

export interface UpkeepReport {
  readonly items: readonly UpkeepItem[];
  /** True when nothing needs attention. */
  readonly clean: boolean;
}

export interface UpkeepOptions {
  readonly vault: Vault;
  /** The project's palace. */
  readonly palace: string;
  /** The project's node, to link loose memories to. */
  readonly projectId: string;
  /** Carry out the changes that are safe and have a reason. Default: only report. */
  readonly apply?: boolean;
}

interface Brief {
  id?: string;
  name?: string;
  text?: string;
}

interface Maintenance {
  duplicates?: { a?: Brief; b?: Brief; score?: number; reasons?: unknown }[];
  duplicate_facts?: { fact?: string; kept?: string; duplicates?: unknown }[];
  superseded?: { older?: Brief; newer?: Brief; overlap?: number }[];
  consolidation?: unknown[];
}

interface Review {
  proposals?: { kind?: string; name?: string; room?: string; how?: string; reason?: string }[];
}

interface Contradictions {
  contradictions?: { constraint?: unknown; action?: string; new?: unknown; old?: unknown }[];
}

/**
 * Looks after the memory: Grafeno's own checks (`maintain`, `palace_review`,
 * `contradictions`), read by the agent. It reports everything; with
 * `apply`, it carries out only what is safe and comes with a reason: it
 * links the memories of a room that hang loose to the project. Merging,
 * archiving what may be superseded, consolidating and moving memories
 * between rooms need judgment: they are reported for a person, or a
 * session, to decide.
 */
export async function upkeep(options: UpkeepOptions): Promise<UpkeepReport> {
  const { vault, palace, projectId } = options;
  const items: UpkeepItem[] = [];

  /** Grafeno's answer to one check; a check that cannot run is reported, never taken as clean. */
  async function check<T>(name: string, args: Record<string, unknown>): Promise<T | undefined> {
    const data = await read<T>(vault, name, args);
    if (data === undefined) {
      items.push({
        kind: "check_failed",
        what: `The check ${name} could not run.`,
        why: "Without it, upkeep cannot say memory is in order.",
      });
    }
    return data;
  }

  const maintenance = (await check<Maintenance>("maintain", { limit: 50 })) ?? {};
  for (const duplicate of maintenance.duplicates ?? []) {
    items.push({
      kind: "duplicate",
      what: `Likely the same memory: ${label(duplicate.a)} and ${label(duplicate.b)} (score ${String(duplicate.score ?? "?")}).`,
      why: "Two memories that say the same thing split what is known about it: merge them, or relate them with distinct_from if they differ.",
    });
  }
  for (const fact of maintenance.duplicate_facts ?? []) {
    items.push({
      kind: "duplicate_fact",
      what: `The same fact recorded twice: ${fact.fact ?? JSON.stringify(fact)}.`,
      why: "A fact recorded twice counts twice.",
    });
  }
  for (const pair of maintenance.superseded ?? []) {
    // A guess by overlap of words: someone has to judge it, so it is only reported.
    items.push({
      kind: "superseded",
      what: `${label(pair.newer)} may have replaced ${label(pair.older)}.`,
      why: 'If it did, mark the older one with feedback "obsolete" and relate them with supersedes.',
    });
  }
  for (const group of maintenance.consolidation ?? []) {
    items.push({
      kind: "consolidation",
      what: `Older memories about one subject could be summarized: ${JSON.stringify(group)}`,
      why: "A summary keeps the context short; it needs someone to write it (consolidate).",
    });
  }

  const review = (await check<Review>("palace_review", { palace })) ?? {};
  for (const proposal of review.proposals ?? []) {
    const item: UpkeepItem = {
      kind: `palace:${proposal.kind ?? "proposal"}`,
      what: `Room ${proposal.name ?? proposal.room ?? "?"}: ${proposal.how ?? proposal.kind ?? ""}`,
      why: proposal.reason ?? proposal.how ?? "palace_review proposed it",
    };
    if (options.apply === true && proposal.kind === "unconnected_room" && proposal.room) {
      const linked = await linkLoose(vault, palace, proposal.name ?? proposal.room, projectId);
      items.push({ ...item, done: `linked ${String(linked)} memories to the project (part_of)` });
    } else {
      items.push(item);
    }
  }

  const contradictions = (await check<Contradictions>("contradictions", {})) ?? {};
  for (const contradiction of contradictions.contradictions ?? []) {
    if (contradiction.action === "flagged") {
      items.push({
        kind: "contradiction",
        what: `Two facts disagree and both were kept: ${JSON.stringify({ new: contradiction.new, old: contradiction.old })}`,
        why: "Settle it with forget (invalidate the one that ended, or retract the mistaken one).",
      });
    }
  }

  return { items, clean: items.every((item) => item.done !== undefined) };
}

function label(brief: Brief | undefined): string {
  if (!brief) return "?";
  const name = brief.name ?? brief.id ?? "?";
  return brief.text ? `${name} ("${brief.text}")` : name;
}

/** Links each memory of a room that has no relation to the project. */
async function linkLoose(
  vault: Vault,
  palace: string,
  room: string,
  projectId: string,
): Promise<number> {
  const map = await read<{ room?: { loci?: { memories?: { id?: string }[] }[] } }>(
    vault,
    "palace_map",
    { palace, room, memories: true, limit: 200 },
  );
  let linked = 0;
  for (const locus of map?.room?.loci ?? []) {
    for (const memory of locus.memories ?? []) {
      if (typeof memory.id !== "string" || memory.id === projectId) continue;
      const answer = await vault.call("relate", {
        from: memory.id,
        label: "part_of",
        to: projectId,
        method: "upkeep",
        reason: "palace_review found the room's memories unconnected",
      });
      if (!answer.isError) linked++;
    }
  }
  return linked;
}

async function read<T>(
  vault: Vault,
  name: string,
  args: Record<string, unknown>,
): Promise<T | undefined> {
  const answer = await vault.call(name, args);
  if (answer.isError) return undefined;
  if (answer.data !== undefined) return answer.data as T;
  try {
    return JSON.parse(answer.text) as T;
  } catch {
    return undefined;
  }
}

/** The report as text for a person. */
export function describeUpkeep(report: UpkeepReport): string {
  if (report.items.length === 0) return "Memory is in order: nothing to fix.";
  return report.items
    .map(
      (item) =>
        `- [${item.kind}] ${item.what}\n    why: ${item.why}${item.done ? `\n    done: ${item.done}` : ""}`,
    )
    .join("\n");
}
