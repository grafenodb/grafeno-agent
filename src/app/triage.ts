import { collectTurn, type Model, type ToolHost } from "../model/index.js";
import type { Provider, ProviderUsage } from "../providers/types.js";

/**
 * Triage in General Auto (B7c, decided by the user): before a message, a
 * light model decides between answering it directly (one worker, the chat)
 * and orchestrating it (a plan of tasks across every ready provider), so a
 * question never starts several agents. It is one short call to the
 * lightest model with room, with no tools; when it fails or is unclear, the
 * message is answered directly: the cheap way.
 */

export type TriageRoute = "direct" | "orchestrate";

/** The triage has no tools: it only sorts the request. */
const NO_TOOLS: ToolHost = {
  tools: [],
  call: () => Promise.resolve({ content: "The triage has no tools.", isError: true }),
};

export interface TriageDecision {
  readonly route: TriageRoute;
  /** Why, in a few words: shown to the user. */
  readonly reason: string;
  /** The model that decided, as `provider/model`; unset when none could. */
  readonly by?: string;
}

export const TRIAGE_SYSTEM = `You sort a developer's request before an agent works on it. Answer with one line:
DIRECT: <a few words why>  — when one agent can do it in one conversation: a question, an explanation, a review of something small, a small change or fix in a few files.
ORCHESTRATE: <a few words why>  — when it needs a plan of several tasks: building a feature across many files or layers (for example backend, frontend, tests and docs), or several independent parts that could be done in parallel.
When unsure, answer DIRECT. Do not answer the request itself.`;

/** What the light model said, read strictly; anything else is a direct answer. */
export function readTriage(text: string): { route: TriageRoute; reason: string } {
  const line = text.trim().split("\n")[0] ?? "";
  const match = /^\W*(DIRECT|ORCHESTRATE)\W*[:\-—]?\s*(.*)$/i.exec(line);
  if (!match?.[1]) return { route: "direct", reason: "the triage was unclear" };
  const route = match[1].toUpperCase() === "ORCHESTRATE" ? "orchestrate" : "direct";
  const reason = (match[2] ?? "").trim() || (route === "direct" ? "one conversation" : "a plan");
  return { route, reason };
}

/** Asks a light model to triage a message. Never throws: a failure is a direct answer. */
export async function triage(
  message: string,
  model: Model,
  label?: string,
  signal?: AbortSignal,
): Promise<TriageDecision> {
  const by = label ? { by: label } : {};
  try {
    const conversation = await model.open({ system: TRIAGE_SYSTEM, tools: NO_TOOLS, maxSteps: 1 });
    try {
      const turn = await collectTurn(
        conversation.send(`Request:\n<request>\n${message}\n</request>`, signal ? { signal } : {}),
      );
      return { ...readTriage(turn.result.text), ...by };
    } finally {
      await conversation.close();
    }
  } catch {
    return { route: "direct", reason: "the triage could not run", ...by };
  }
}

/** One ready provider with what it has left. */
export interface PoolMember {
  readonly provider: Provider;
  readonly usage?: ProviderUsage;
}

/**
 * The provider with the most room under its limit, among the ready ones (in
 * their order on a tie): the one the chat and the triage use in General
 * Auto. Undefined when every one is at its limit (`holdAbove`).
 */
export function mostRoom(members: readonly PoolMember[], holdAbove = 0.95): PoolMember | undefined {
  const used = (m: PoolMember) => Math.max(0, ...(m.usage?.limits.map((l) => l.used) ?? [0]));
  return members
    .filter((m) => used(m) < holdAbove)
    .map((m, index) => ({ m, index }))
    .sort((a, b) => used(a.m) - used(b.m) || a.index - b.index)[0]?.m;
}

/** The lightest model of a provider, as its own tiers name it; undefined: its own choice. */
export function lightModel(provider: Provider): string | undefined {
  return provider.tiers?.light[0];
}
