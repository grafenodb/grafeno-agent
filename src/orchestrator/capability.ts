import type { AttemptRecord } from "./metrics.js";
import type { TaskSpec } from "./plan.js";
import { bandOf, wilson, type Band, type Rate } from "./stats.js";

/**
 * What each model, at each effort, was really seen to do: the objective
 * record the minimum-sufficient router decides from. Everything here comes
 * from what code observed (checks run by the verifier, attempts counted,
 * the plan's usage read from the provider), never from a model's opinion
 * of its own work.
 */

/** Who is to blame for an attempt that did not end well. */
export type Fault = "model" | "environment" | "ambiguous";

/** Failure categories that are never the model's doing. */
const ENVIRONMENT_CATEGORIES = new Set([
  "usage_limit",
  "quota",
  "moved",
  "setup",
  "cancelled",
  "lost",
  "unavailable",
]);

/** What a failure's text says when the environment, not the model, stopped the work. */
const ENVIRONMENT_TEXT: readonly RegExp[] = [
  /did not allow|not allowed|needs? (a person's )?permission|waiting for approval|refused when no one/i,
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i,
  /command not found|is not recognized as an internal or external command|No such file or directory: '[^']*(python|node|npm|cargo|go)/i,
  /ModuleNotFoundError|Cannot find module|No module named|could not resolve dependency|ERR_MODULE_NOT_FOUND/i,
  /conflicts? in |merge conflict/i,
  /the attempt was interrupted|the process ended|stopped$/i,
  /rate limit|overloaded|503|502|429/i,
];

/** What it says when the requirement itself was unclear: nobody's fault that code can settle. */
const AMBIGUOUS_TEXT: readonly RegExp[] = [
  /a person decides|still asks for changes|ambiguous|unclear requirement|the reviewer/i,
];

/**
 * A check whose own command was broken (a shell or awk syntax error, an
 * operator read as a file name): it says nothing of the work, so the
 * failure is nobody's that code can settle. A missing file is not this:
 * that may well be the work's doing.
 */
const BROKEN_CHECK_TEXT =
  /exited (?:2|126|127):\s*[^\n]*?(?:syntax error|unexpected (?:EOF|end of file|token)|bad substitution|unterminated|awk: (?:cmd\. line|syntax)|cannot open file .(?:==|!=|<=|>=|-eq|-ne|-lt|-gt|-le|-ge).)/i;

/** Whether a failure's text shows one of the task's checks was itself broken. */
export function brokenCheck(reason: string | undefined): boolean {
  return BROKEN_CHECK_TEXT.test(reason ?? "");
}

/**
 * Whose fault a failed attempt was, by code: from its failure category (the
 * kind of error) and the reason given when it ended (the checks'
 * diagnostic, the error's message). A model is blamed only for what it
 * could have done better: failed checks, running out of steps, declining.
 */
export function classifyFailure(category: string | undefined, reason: string | undefined): Fault {
  if (category !== undefined && ENVIRONMENT_CATEGORIES.has(category)) return "environment";
  const text = reason ?? "";
  if (AMBIGUOUS_TEXT.some((pattern) => pattern.test(text))) return "ambiguous";
  if (brokenCheck(text)) return "ambiguous";
  if (ENVIRONMENT_TEXT.some((pattern) => pattern.test(text))) return "environment";
  if (category === "error" && text === "") return "ambiguous";
  return "model";
}

/**
 * What kind of failure it was, finer than whose fault: what decides whether
 * to retry the same arm, move to another provider, escalate, or ask a
 * person. Only `capability`, `verification` and `context` are the model's;
 * none of the others says anything about what it can do.
 */
export type FailureClass =
  /** The model could not do the work. */
  | "capability"
  /** Its work failed the task's checks: a diagnostic it can act on. */
  | "verification"
  /** It ran out of steps or context: more effort, or a renewed session, before a stronger model. */
  | "context"
  /** A tool or program it needed was missing or refused. */
  | "tools"
  /** The provider or the network failed. */
  | "infrastructure"
  /** The sign-in or key was refused. */
  | "auth"
  /** A usage limit or quota: another provider, or waiting, never a stronger model. */
  | "quota"
  /** The requirement was unclear: a person decides. */
  | "ambiguous";

const QUOTA_TEXT = /rate limit|usage limit|quota|429|too many requests/i;
const AUTH_TEXT =
  /refused the key|not signed in|sign in|unauthori[sz]ed|401|forbidden|invalid api key/i;
const TOOLS_TEXT =
  /did not allow|not allowed|needs? (a person's )?permission|command not found|is not recognized as|ENOENT|Cannot find module|No module named|ModuleNotFoundError/i;
const INFRA_TEXT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up|overloaded|503|502|could not be reached|stopped answering|interrupted|the process ended/i;
const CONTEXT_TEXT =
  /step limit|ran out of (steps|context)|context (window|length)|max_tokens|too long/i;

/** The finer kind of a failure, by code, from its category and reason (never the model's word). */
export function failureClass(
  category: string | undefined,
  reason: string | undefined,
): FailureClass {
  const text = reason ?? "";
  if (category === "usage_limit" || category === "quota" || category === "moved") return "quota";
  if (category === "setup") return "auth";
  if (category === "unavailable" || category === "lost" || category === "cancelled")
    return "infrastructure";
  if (AMBIGUOUS_TEXT.some((pattern) => pattern.test(text))) return "ambiguous";
  if (brokenCheck(text)) return "ambiguous";
  if (QUOTA_TEXT.test(text)) return "quota";
  if (AUTH_TEXT.test(text)) return "auth";
  if (TOOLS_TEXT.test(text)) return "tools";
  if (INFRA_TEXT.test(text)) return "infrastructure";
  if (category === "checks") return "verification";
  if (category === "timeout" || category === "max_steps" || CONTEXT_TEXT.test(text))
    return "context";
  if (ENVIRONMENT_TEXT.some((pattern) => pattern.test(text))) return "infrastructure";
  if (category === "error" && text === "") return "ambiguous";
  return "capability";
}

/** How much a wrong result would cost: decided by code from what the task touches. */
export type Risk = "low" | "normal" | "high";

const RISKY_PATHS =
  /(^|\/)(migrations?|auth|security|crypto|payments?|billing|infra|deploy|\.github\/workflows|terraform|k8s|schema)(\/|\.|$)|\.(sql|tf)$/i;
const SAFE_PATHS = /(^|\/)(docs?|examples?|README|CHANGELOG)|\.(md|txt|rst)$/i;

/**
 * A task's risk: high when it touches what is costly to get wrong (schemas,
 * auth, payments, CI, infrastructure) or is the hardest kind of work; low
 * when it only touches documents or tests with a command that checks them.
 */
export function riskOf(
  task: Pick<TaskSpec, "kind" | "complexity" | "touches" | "acceptance">,
): Risk {
  if (task.touches.some((path) => RISKY_PATHS.test(path))) return "high";
  if (task.complexity >= 5) return "high";
  const checked = task.acceptance.some((a) => a.check === "command");
  if (task.touches.length > 0 && task.touches.every((path) => SAFE_PATHS.test(path))) return "low";
  if ((task.kind === "docs" || task.kind === "tests") && checked) return "low";
  return "normal";
}

const TECH: readonly (readonly [RegExp, string])[] = [
  [/\.(ts|tsx|mts|cts)$/i, "typescript"],
  [/\.(js|jsx|mjs|cjs)$/i, "javascript"],
  [/\.py$|pyproject\.toml$/i, "python"],
  [/\.rs$|Cargo\.toml$/i, "rust"],
  [/\.go$|go\.mod$/i, "go"],
  [/\.(java|kt)$/i, "jvm"],
  [/\.(cs|fs)$/i, "dotnet"],
  [/\.(c|cc|cpp|h|hpp)$/i, "c"],
  [/\.(sql)$/i, "sql"],
  [/\.(ya?ml|toml|json)$/i, "config"],
  [/\.(md|rst|txt)$/i, "docs"],
];

/** The technology a task mostly touches, from its files; `mixed` or `unknown` otherwise. */
export function techOf(touches: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const path of touches) {
    const found = TECH.find(([pattern]) => pattern.test(path))?.[1];
    if (found) counts.set(found, (counts.get(found) ?? 0) + 1);
    else {
      const folder = /(^|\/)(python|typescript|rust|go)(\/|$)/i.exec(path)?.[2]?.toLowerCase();
      if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "unknown";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const code = sorted.filter(([name]) => name !== "docs" && name !== "config");
  if (code.length > 1 && (code[0]?.[1] ?? 0) === (code[1]?.[1] ?? 0)) return "mixed";
  return (code[0] ?? sorted[0])?.[0] ?? "unknown";
}

/** The capability a task kind exercises: each is learned apart. */
export type Role = "planning" | "implementation" | "debugging" | "review";

export function roleOf(kind: string): Role {
  if (kind === "architecture") return "planning";
  if (kind === "debug") return "debugging";
  if (kind === "review") return "review";
  return "implementation";
}

/** One arm's objective record within a cell (a task kind and complexity band). */
export interface ArmEvidence {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly key: string;
  /** Attempts the model can be judged by: those that ended for a reason of its own. */
  readonly attempts: number;
  /** Of those, the ones whose result passed the checks (run by code). */
  readonly passed: number;
  /** First attempts of a task on this arm, judged the same way: success with no retry. */
  readonly first: Rate;
  /** Attempts that ended for a reason of the environment: counted, never held against the model. */
  readonly environment: number;
  /** Attempts whose blame code could not settle: counted apart. */
  readonly ambiguous: number;
  /** Times a person had to answer something during its attempts. */
  readonly human: number;
  /** Mean milliseconds per judged attempt. */
  readonly ms: number;
  /** Mean share of the provider's window per attempt, over the attempts that measured it. */
  readonly share?: number;
  readonly shareSamples: number;
  /** The exact model versions seen, latest last; evidence of older ones counts half. */
  readonly versions: readonly string[];
  /** Judged attempts, with older versions' discounted: what the router weighs. */
  readonly weight: number;
  readonly weightedPassed: number;
  /** Failure categories of the model's own failures, with counts. */
  readonly causes: Readonly<Record<string, number>>;
}

export interface CellEvidence {
  readonly kind: string;
  readonly band: Band;
  readonly key: string;
  readonly arms: readonly ArmEvidence[];
}

/** How much an older model version's attempts count once a newer one is seen. */
export const OLD_VERSION_WEIGHT = 0.5;

export function evidenceKey(provider: string, model: string, effort: string | undefined): string {
  return `${provider}/${model}${effort ? ` · ${effort}` : ""}`;
}

/**
 * The evidence in the recorded attempts, by cell and arm. An attempt is
 * judged when it ended for a reason of the model's own: it passed when its
 * work was verified (its checks ran and passed), failed otherwise.
 * Explored attempts count like any other: they are how cheaper arms get
 * evidence at all.
 */
export function computeEvidence(attempts: readonly AttemptRecord[]): CellEvidence[] {
  interface Acc {
    provider: string;
    model: string;
    effort?: string;
    attempts: number;
    passed: number;
    firstN: number;
    firstPassed: number;
    environment: number;
    ambiguous: number;
    human: number;
    ms: number;
    share: number;
    shareSamples: number;
    versions: string[];
    byVersion: Map<string, { n: number; passed: number }>;
    causes: Record<string, number>;
  }
  const cells = new Map<string, { kind: string; band: Band; arms: Map<string, Acc> }>();
  for (const a of [...attempts].sort((x, y) => x.at.localeCompare(y.at))) {
    const band = bandOf(a.complexity);
    const cellKey = `${a.kind} · ${band}`;
    const cell = cells.get(cellKey) ?? { kind: a.kind, band, arms: new Map<string, Acc>() };
    cells.set(cellKey, cell);
    const key = evidenceKey(a.provider, a.model, a.effort);
    const acc: Acc = cell.arms.get(key) ?? {
      provider: a.provider,
      model: a.model,
      ...(a.effort ? { effort: a.effort } : {}),
      attempts: 0,
      passed: 0,
      firstN: 0,
      firstPassed: 0,
      environment: 0,
      ambiguous: 0,
      human: 0,
      ms: 0,
      share: 0,
      shareSamples: 0,
      versions: [],
      byVersion: new Map(),
      causes: {},
    };
    cell.arms.set(key, acc);
    acc.human += a.human ?? 0;
    if (a.quotaShare !== undefined) {
      acc.share += a.quotaShare;
      acc.shareSamples++;
    }
    const verdict = judge(a);
    if (verdict === "environment") {
      acc.environment++;
      continue;
    }
    if (verdict === "ambiguous") {
      acc.ambiguous++;
      continue;
    }
    const version = a.modelVersion ?? "";
    if (!acc.versions.includes(version)) acc.versions.push(version);
    const v = acc.byVersion.get(version) ?? { n: 0, passed: 0 };
    acc.byVersion.set(version, v);
    v.n++;
    acc.attempts++;
    acc.ms += a.ms;
    if (verdict === "passed") {
      acc.passed++;
      v.passed++;
    } else {
      const cause = a.failure ?? "checks";
      acc.causes[cause] = (acc.causes[cause] ?? 0) + 1;
    }
    if (a.attempt === 1) {
      acc.firstN++;
      if (verdict === "passed") acc.firstPassed++;
    }
  }
  return [...cells.entries()]
    .map(([key, cell]) => ({
      kind: cell.kind,
      band: cell.band,
      key,
      arms: [...cell.arms.values()]
        .map((acc): ArmEvidence => {
          const latest = acc.versions.at(-1);
          let weight = 0;
          let weightedPassed = 0;
          for (const [version, v] of acc.byVersion) {
            const w = version === latest ? 1 : OLD_VERSION_WEIGHT;
            weight += v.n * w;
            weightedPassed += v.passed * w;
          }
          return {
            provider: acc.provider,
            model: acc.model,
            ...(acc.effort ? { effort: acc.effort } : {}),
            key: evidenceKey(acc.provider, acc.model, acc.effort),
            attempts: acc.attempts,
            passed: acc.passed,
            first: wilson(acc.firstPassed, acc.firstN),
            environment: acc.environment,
            ambiguous: acc.ambiguous,
            human: acc.human,
            ms: acc.attempts === 0 ? 0 : Math.round(acc.ms / acc.attempts),
            ...(acc.shareSamples > 0 ? { share: acc.share / acc.shareSamples } : {}),
            shareSamples: acc.shareSamples,
            versions: acc.versions.filter((v) => v !== ""),
            weight,
            weightedPassed,
            causes: acc.causes,
          };
        })
        .sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * How an attempt counts: `passed` (verified), `failed` (the model's own
 * failure), or not held against the model (`environment`, `ambiguous`).
 * Records made before faults were kept are judged by their outcome alone.
 */
export function judge(
  a: Pick<AttemptRecord, "outcome" | "failure" | "verified" | "fault">,
): "passed" | "failed" | "environment" | "ambiguous" {
  if (a.outcome === "quota" || a.outcome === "moved") return "environment";
  if (a.fault === "environment") return "environment";
  if (a.fault === "ambiguous") return "ambiguous";
  if (a.outcome === "completed") {
    // Completed and its checks passed, or completed with no verifier to say otherwise.
    if (a.verified === false || a.fault === "model") return "failed";
    return "passed";
  }
  if (a.fault === undefined && a.failure !== undefined && ENVIRONMENT_CATEGORIES.has(a.failure)) {
    return "environment";
  }
  return "failed";
}
