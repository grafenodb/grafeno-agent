import { computeEvidence, judge, type CellEvidence } from "./capability.js";
import type { AttemptRecord } from "./metrics.js";
import { bandOf, wilson } from "./stats.js";

const pct = (value: number) => `${String(Math.round(value * 100))}%`;

/** Attempts on an arm and cell from which its rate is evidence rather than a hint. */
const EVIDENCE_SAMPLE = 10;

/** The evidence as lines for a person: per kind and band, what each arm was seen to do. */
export function describeEvidence(cells: readonly CellEvidence[]): string[] {
  if (cells.length === 0) return ["No attempt is recorded yet: the router decides by its priors."];
  const lines = [
    "What each model was seen to do (attempts judged by code: passed = its checks passed).",
    "Attempts stopped by the environment (limits, permissions, missing tools, conflicts) are counted apart and never held against the model.",
  ];
  for (const cell of cells) {
    lines.push("", cell.key);
    for (const arm of cell.arms) {
      const rate = wilson(arm.passed, arm.attempts);
      const judged =
        arm.attempts === 0
          ? "no judged attempt"
          : `${pct(rate.rate)} passed [${pct(rate.low)}–${pct(rate.high)}] of ${String(arm.attempts)}`;
      const first =
        arm.first.n > 0 ? ` · first attempt ${pct(arm.first.rate)} of ${String(arm.first.n)}` : "";
      const share =
        arm.share === undefined
          ? " · share of a window: not measured"
          : ` · ${(arm.share * 100).toFixed(1)}% of a window per attempt (${String(arm.shareSamples)} measured)`;
      const apart = [
        arm.environment > 0 ? `${String(arm.environment)} environment` : "",
        arm.ambiguous > 0 ? `${String(arm.ambiguous)} unclear` : "",
        arm.human > 0 ? `${String(arm.human)} answered by a person` : "",
      ].filter(Boolean);
      const causes = Object.entries(arm.causes).map(([cause, n]) => `${cause} ${String(n)}`);
      const flags = [
        arm.attempts < EVIDENCE_SAMPLE ? "small sample" : "",
        arm.versions.length > 1
          ? `new version ${arm.versions.at(-1) ?? ""}: older attempts count half`
          : "",
      ].filter(Boolean);
      lines.push(
        `  ${arm.key.padEnd(34)} ${judged}${first}${share} · ${String(Math.round(arm.ms / 1000))} s`,
      );
      const extra = [
        apart.length > 0 ? `apart: ${apart.join(", ")}` : "",
        causes.length > 0 ? `its failures: ${causes.join(", ")}` : "",
        ...flags,
      ].filter(Boolean);
      if (extra.length > 0) lines.push(`  ${" ".repeat(34)} ${extra.join(" · ")}`);
    }
  }
  return lines;
}

/** How much of the work that is not hard went to deep models, and how well the router knows its arms. */
export interface LearningQuality {
  /** Judged attempts on tasks of low or medium complexity, and how many ran on a deep model. */
  readonly easyAttempts: number;
  readonly easyOnDeep: number;
  /** Arms (per cell) with enough attempts to count as evidence, of all seen. */
  readonly armsWithEvidence: number;
  readonly arms: number;
  /** Attempts not held against a model, of all recorded. */
  readonly excluded: number;
  readonly attempts: number;
  /** Escalations: attempts that ran on a stronger arm after a failure. */
  readonly escalations: number;
  readonly warnings: readonly string[];
}

/** Above this share of non-hard work on deep models, the router is spending more than it needs. */
export const HEAVY_USE = 0.25;

export function learningQuality(attempts: readonly AttemptRecord[]): LearningQuality {
  const cells = computeEvidence(attempts);
  const judged = attempts.filter((a) => {
    const verdict = judge(a);
    return verdict === "passed" || verdict === "failed";
  });
  const easy = judged.filter((a) => bandOf(a.complexity) !== "high");
  const easyOnDeep = easy.filter((a) => a.tier === "deep").length;
  const arms = cells.flatMap((c) => c.arms);
  const warnings: string[] = [];
  if (easy.length >= EVIDENCE_SAMPLE && easyOnDeep / easy.length > HEAVY_USE) {
    warnings.push(
      `${pct(easyOnDeep / easy.length)} of the attempts on tasks of low or medium complexity ran on deep models (over ${pct(HEAVY_USE)}): check AGENT_ROUTING, AGENT_AFFINITY and AGENT_AUTO_MODELS.`,
    );
  }
  for (const cell of cells) {
    if (cell.band === "high") continue;
    const tried = cell.arms.filter((a) => a.attempts > 0);
    const only = tried[0];
    if (tried.length === 1 && only && only.attempts >= EVIDENCE_SAMPLE) {
      warnings.push(
        `${cell.key}: only ${only.key} was ever tried, so nothing says a cheaper arm would not do.`,
      );
    }
  }
  return {
    easyAttempts: easy.length,
    easyOnDeep,
    armsWithEvidence: arms.filter((a) => a.attempts >= EVIDENCE_SAMPLE).length,
    arms: arms.length,
    excluded: attempts.length - judged.length,
    attempts: attempts.length,
    escalations: attempts.filter((a) => a.escalatedFrom !== undefined).length,
    warnings,
  };
}

export function describeQuality(quality: LearningQuality): string[] {
  const share = quality.easyAttempts === 0 ? 0 : quality.easyOnDeep / quality.easyAttempts;
  return [
    "How well the router knows its models:",
    `  ${String(quality.armsWithEvidence)} of ${String(quality.arms)} arms (a model and effort on a kind of task) have ${String(EVIDENCE_SAMPLE)} or more judged attempts; the rest are decided mostly by the prior.`,
    `  ${String(quality.excluded)} of ${String(quality.attempts)} attempts were not held against a model (environment, or unclear).`,
    `  ${String(quality.escalations)} attempts were escalations after a failure.`,
    `  Deep models took ${String(quality.easyOnDeep)} of ${String(quality.easyAttempts)} attempts on tasks of low or medium complexity (${pct(share)}).`,
    ...quality.warnings.map((w) => `  ! ${w}`),
  ];
}
