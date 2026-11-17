import { bandOf } from "./stats.js";
import type { AttemptRecord } from "./metrics.js";
import { PRIOR_WEIGHT, type Decision } from "./sufficient.js";

/**
 * What the router's choices came to, from the recorded attempts: what each
 * kind of task spent, what was tried on purpose to learn, what kinds of
 * failure there were, and which arms are still too little tried for their
 * evidence to mean anything. Measured where the provider measured;
 * "unknown" where it did not (never taken as zero).
 */
export function describeRouting(attempts: readonly AttemptRecord[]): string[] {
  if (attempts.length === 0) return ["No attempts recorded yet: nothing to say of the router."];
  const lines: string[] = [
    "What the routing spent, by kind of task (measured where the provider said):",
  ];
  const cells = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const key = `${a.kind} · ${bandOf(a.complexity)}`;
    cells.set(key, [...(cells.get(key) ?? []), a]);
  }
  for (const [key, list] of [...cells].sort((a, b) => b[1].length - a[1].length)) {
    const measured = list.filter((a) => a.quotaShare !== undefined);
    const share = measured.reduce((n, a) => n + (a.quotaShare ?? 0), 0);
    const tokens = list.reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);
    const hours = list.reduce((n, a) => n + a.ms, 0) / 3_600_000;
    const passed = list.filter((a) => a.verified === true).length;
    lines.push(
      `  ${key.padEnd(26)} ${String(list.length).padStart(4)} attempts  ${String(passed).padStart(3)} passed  ${tokens > 0 ? `${String(Math.round(tokens / 1000))}k tokens` : "tokens unknown"}  ${hours.toFixed(2)} h  ${
        measured.length === 0
          ? "plan share unknown"
          : `${(share * 100).toFixed(1)}% of a window over ${String(measured.length)} measured${measured.length < list.length ? ` (${String(list.length - measured.length)} unknown)` : ""}`
      }`,
    );
  }

  const explored = attempts.filter((a) => a.explored);
  lines.push(
    "",
    explored.length === 0
      ? "Exploration: no attempt was made on purpose to learn yet."
      : `Exploration: ${String(explored.length)} attempt${explored.length === 1 ? "" : "s"} on purpose to learn, ${String(explored.filter((a) => a.verified === true).length)} passed.`,
  );

  const classes = new Map<string, number>();
  for (const a of attempts) {
    if (a.outcome === "completed") continue;
    const kind = a.failureClass ?? a.fault ?? "unclassified";
    classes.set(kind, (classes.get(kind) ?? 0) + 1);
  }
  if (classes.size > 0) {
    lines.push(
      `Failures by kind: ${[...classes]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${String(n)}`)
        .join(", ")} (only capability, verification and context count against a model).`,
    );
  }

  const arms = new Map<string, Map<string, number>>();
  for (const a of attempts) {
    const arm = `${a.provider}/${a.model}${a.effort ? ` · ${a.effort}` : ""}`;
    const cell = `${a.kind} · ${bandOf(a.complexity)}`;
    const per = arms.get(arm) ?? new Map<string, number>();
    per.set(cell, (per.get(cell) ?? 0) + 1);
    arms.set(arm, per);
  }
  const thin = [...arms]
    .map(([arm, per]) => ({ arm, thin: [...per].filter(([, n]) => n < PRIOR_WEIGHT) }))
    .filter((a) => a.thin.length > 0);
  lines.push(
    "",
    thin.length === 0
      ? "Every arm tried has enough attempts on each kind of task it took to start counting."
      : `Too little tried to mean anything yet (under ${String(PRIOR_WEIGHT)} attempts on a kind of task; the prior still decides there):`,
    ...thin
      .slice(0, 20)
      .map((a) => `  ${a.arm}: ${a.thin.map(([cell, n]) => `${cell} (${String(n)})`).join(", ")}`),
    "Models never tried do not appear here: their choices rest on the priors alone (an assumption, not a measure).",
  );
  return lines;
}

/** What the leader's recommendations and the exploration came to in a run's decisions. */
export function describeDecisionsSummary(decisions: readonly Decision[]): string[] {
  const advised = decisions.filter((d) => d.advice);
  const followed = advised.filter((d) => d.advice?.followed === true);
  const explored = decisions.filter((d) => d.explored);
  const states = new Map<string, number>();
  for (const d of decisions) states.set(d.state, (states.get(d.state) ?? 0) + 1);
  return [
    `${String(decisions.length)} decision${decisions.length === 1 ? "" : "s"}: ${[...states].map(([s, n]) => `${String(n)} on ${s} evidence`).join(", ")}.`,
    advised.length === 0
      ? "The leader recommended no model for these tasks."
      : `The leader's recommendation: followed ${String(followed.length)} of ${String(advised.length)} times (the router decides; the leader advises).`,
    ...(explored.length > 0
      ? [`${String(explored.length)} chosen on purpose to learn (exploration).`]
      : []),
  ];
}
