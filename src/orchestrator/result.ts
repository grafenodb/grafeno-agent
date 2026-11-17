import type { RunEvent, TaskRecord } from "./store.js";

/** What a run came to, for the person: a headline, then each task with its result. */
export interface RunResult {
  readonly ok: boolean;
  readonly headline: string;
  /** One line per task: its state, its title, and what it did or why it did not. */
  readonly tasks: readonly string[];
}

const firstLine = (text: string, max = 160) => {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The result of a run in plain words: how many tasks were done, and for
 * each what its worker said it did (its last finished attempt), or why it
 * failed or waits.
 */
export function describeResult(
  tasks: readonly TaskRecord[],
  events: readonly RunEvent[],
  state: string,
): RunResult {
  const said = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "attempt_ended" || event.taskId === undefined) continue;
    if (event.data.status === "completed" && typeof event.data.summary === "string") {
      said.set(event.taskId, event.data.summary);
    }
  }
  const count = (s: string) => tasks.filter((t) => t.state === s).length;
  const completed = count("completed");
  const failed = count("failed");
  const review = count("review");
  const left = tasks.length - completed - failed - review - count("cancelled");
  const parts = [
    `${String(completed)} of ${String(tasks.length)} task${tasks.length === 1 ? "" : "s"} done`,
    ...(failed > 0 ? [`${String(failed)} failed`] : []),
    ...(review > 0 ? [`${String(review)} waiting for you`] : []),
    ...(left > 0 && state !== "completed" ? [`${String(left)} not done`] : []),
  ];
  const ok = state === "completed" && completed === tasks.length;
  const headline =
    state === "completed"
      ? `${ok ? "Done" : "Finished"}: ${parts.join(", ")}.`
      : state === "cancelled"
        ? `Cancelled: ${parts.join(", ")}.`
        : state === "paused" || state === "waiting"
          ? `Not finished (${state}): ${parts.join(", ")}.`
          : `Stopped: ${parts.join(", ")}.`;
  const mark: Readonly<Record<string, string>> = {
    completed: "✓",
    failed: "✗",
    review: "?",
    cancelled: "–",
  };
  // What the run's leader decided of each task: approved, sent back, its suggestions.
  const audits = events.filter((e) => e.kind === "reviewed" && e.data.leader === true);
  const leaderNote = (id: string) => {
    const mine = audits.filter((e) => e.taskId === id);
    const last = mine.at(-1);
    if (!last) return "";
    const back = mine.filter((e) => e.data.verdict === "changes").length;
    const suggestions = Array.isArray(last.data.suggestions) ? last.data.suggestions.length : 0;
    const verdict = last.data.verdict === "ok" ? "approved by the leader" : "not approved yet";
    return ` · ${verdict}${back > 0 ? `, sent back ${String(back)}×` : ""}${
      suggestions > 0 ? `, ${String(suggestions)} suggestion${suggestions === 1 ? "" : "s"}` : ""
    }`;
  };
  // Checks the plan's author corrected (they were wrong, not the work).
  const repaired = events.filter((e) => e.kind === "checks_repaired");
  const checksNote = (id: string) => {
    const mine = repaired.filter((e) => e.taskId === id);
    if (mine.length === 0) return "";
    const by = mine.at(-1)?.data.judge;
    return ` · checks corrected${typeof by === "string" ? ` by ${by}` : ""}${mine.length > 1 ? ` (${String(mine.length)}×)` : ""}`;
  };
  const lines = tasks.map((t) => {
    const what =
      t.state === "completed"
        ? firstLine(said.get(t.id) ?? "")
        : t.reason
          ? firstLine(failedCheckLine(t.reason))
          : t.state;
    return `${mark[t.state] ?? "·"} ${t.spec.title}${what ? ` — ${what}` : ""}${leaderNote(t.id)}${checksNote(t.id)}`;
  });
  const reviewer = audits.find((e) => typeof e.data.reviewer === "string")?.data.reviewer;
  const approved = new Set(audits.filter((e) => e.data.verdict === "ok").map((e) => e.taskId)).size;
  const sentBack = audits.filter((e) => e.data.verdict === "changes").length;
  const leaderLine =
    audits.length > 0
      ? [
          `The leader (${String(reviewer)}) approved ${String(approved)} task${approved === 1 ? "" : "s"}${
            sentBack > 0
              ? ` and sent work back ${String(sentBack)} time${sentBack === 1 ? "" : "s"}`
              : ""
          }.`,
        ]
      : [];
  return { ok, headline, tasks: [...leaderLine, ...lines] };
}

/** A failed-checks reason told by its first failing check, not by its heading. */
function failedCheckLine(reason: string): string {
  if (!reason.startsWith("These checks failed")) return reason;
  const check = reason.split("\n").find((line) => line.startsWith("- "));
  return check ? `check failed: ${check.slice(2)}` : reason;
}
