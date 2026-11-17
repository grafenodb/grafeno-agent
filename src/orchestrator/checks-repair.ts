import { collectTurn, type Model, type ToolHost } from "../model/index.js";
import { brokenCheck } from "./capability.js";
import { readChecks, type Acceptance, type TaskSpec } from "./plan.js";
import { extractJson } from "./planner.js";

/**
 * Checks that are wrong, not the work: the plan's checks are written by a
 * model, and a model can write a check that cannot pass (a shell or awk
 * syntax error) or one that asks for something the task did not (counting
 * lines of a file with no final newline). Retrying the worker against such
 * a check spends attempts and blames a model that did the work.
 *
 * When a check fails in one of two telling ways, whoever wrote the plan
 * (the run's leader, else the planner's model) is asked to judge it:
 * - `broken`: the check's own command failed (see `brokenCheck`);
 * - `disputed`: the same check failed with the same output again, after
 *   the worker had been given its diagnostic.
 * It answers that the check is wrong, with corrected checks, or that the
 * work is. Corrected checks are read with the plan's own rules (forbidden
 * commands refused), must still check something, and are run on the same
 * work at once; the old and new checks are recorded with the run.
 */

/** Why a check is sent to be judged. */
export type CheckDoubt = "broken" | "disputed";

export type CheckJudgement =
  /** The checks were wrong: these replace them. */
  | { readonly verdict: "check"; readonly acceptance: readonly Acceptance[]; readonly why: string }
  /** The checks are right: the work must change. */
  | { readonly verdict: "work"; readonly why: string }
  /** It could not be asked, or its answer could not be used: the checks stand. */
  | { readonly verdict: "none"; readonly reason: string };

/** Repairs a task may have: a judge that keeps rewriting checks is a sign to stop. */
export const MAX_CHECK_REPAIRS = 2;

export const CHECK_JUDGE_SYSTEM = `You wrote the acceptance checks of a plan, and one of a task's checks failed in a way that suggests the check, not the work, is wrong. Decide which it is.

- The check is wrong when its own command cannot work (a syntax error, an operator read as a file name, a tool used the wrong way) or when it asks for something the task did not ask for (an exact byte or line count the task never stated, a trailing newline it never required).
- The work is wrong when it does not do what the task asks, whatever the check's shape.

When the check is wrong, give corrected checks for the whole task: the same requirement, said correctly. Never weaken a check into one that passes whatever the work is (no "true", "exit 0" or a bare "echo"), and keep every check that was right. Prefer simple, portable commands (test, grep -q, diff) over clever pipelines.

Answer with JSON only:
{ "verdict": "check" | "work", "why": "one sentence", "acceptance": [ { "check": "command", "run": "..." } or { "check": "files", "exist": ["..."] } ] }
"acceptance" only when the verdict is "check".`;

const NO_TOOLS: ToolHost = {
  tools: [],
  call: () => Promise.resolve({ content: "The judge has no tools.", isError: true }),
};

/** Commands that pass whatever the work is. */
const TRIVIAL = /^\s*(?:true|:|exit\s+0|echo\b[^|;&<>]*|printf\b[^|;&<>]*)\s*;?\s*$/i;

/** Whether a check command passes whatever the work is. */
export function trivialCheck(run: string): boolean {
  return TRIVIAL.test(run);
}

/** Why a failed verification should be judged, if it should. */
export function checkDoubt(
  diagnostic: string,
  previous: string | undefined,
): CheckDoubt | undefined {
  if (brokenCheck(diagnostic)) return "broken";
  if (previous !== undefined && previous.trim() !== "" && previous === diagnostic)
    return "disputed";
  return undefined;
}

/** Reads a judge's answer; corrected checks that cannot be used leave the checks as they are. */
export function readJudgement(text: string, task: Pick<TaskSpec, "id">): CheckJudgement {
  const json = extractJson(text);
  if (typeof json !== "object" || json === null) {
    return { verdict: "none", reason: "the answer was not JSON" };
  }
  const answer = json as Record<string, unknown>;
  const why = typeof answer.why === "string" ? answer.why.trim() : "";
  if (answer.verdict === "work") return { verdict: "work", why };
  if (answer.verdict !== "check") {
    return { verdict: "none", reason: `an unknown verdict "${String(answer.verdict)}"` };
  }
  const { acceptance, problems } = readChecks(shorthand(answer.acceptance), `Task "${task.id}"`);
  if (problems.length > 0) return { verdict: "none", reason: problems.join("; ") };
  const checked = acceptance.filter((a) => a.check !== "review");
  if (checked.length === 0) {
    return { verdict: "none", reason: "the corrected checks check nothing by code" };
  }
  const trivial = checked.find((a) => a.check === "command" && trivialCheck(a.run));
  if (trivial && trivial.check === "command") {
    return { verdict: "none", reason: `"${trivial.run}" passes whatever the work is` };
  }
  return { verdict: "check", acceptance, why };
}

const KINDS = new Set(["command", "files", "review"]);

/**
 * Checks as small models write them, in the plan's shape: a bare command
 * (`"grep -q x f"`), a command where its kind goes (`{"check": "grep -q x
 * f"}`, seen from a real local model), or `{"command": "..."}`. The plan's
 * rules are applied after, all the same.
 */
function shorthand(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item: unknown) => {
    if (typeof item === "string") return { check: "command", run: item };
    if (typeof item !== "object" || item === null) return item;
    const entry = item as Record<string, unknown>;
    if (typeof entry.check === "string" && !KINDS.has(entry.check)) {
      // The command where the kind goes, with `run` left out or empty (both seen).
      const run =
        typeof entry.run === "string" && entry.run.trim() !== "" ? entry.run : entry.check;
      return { check: "command", run };
    }
    if (entry.check === undefined && typeof entry.command === "string") {
      return { check: "command", run: entry.command };
    }
    return item;
  });
}

/** Asks the plan's author whether the checks or the work are wrong. */
export async function judgeChecks(
  model: Model,
  task: TaskSpec,
  doubt: CheckDoubt,
  diagnostic: string,
  diff: string,
  signal?: AbortSignal,
): Promise<CheckJudgement> {
  const checks = task.acceptance
    .map((a) =>
      a.check === "command"
        ? `- command: \`${a.run}\` must exit 0`
        : a.check === "files"
          ? `- files must exist: ${a.exist.join(", ")}`
          : `- a person checks: ${a.criteria}`,
    )
    .join("\n");
  const how =
    doubt === "broken"
      ? "The check's own command failed: its output shows an error of the command, not of the work."
      : "The same check failed with the same output again, after the worker was given its diagnostic and tried to fix the work.";
  const message = `Task "${task.title}" (${task.kind}): ${task.description}

Its checks:
${checks}

${how}

What the checks said:
<checks>
${diagnostic}
</checks>

The work (its change):
<diff>
${diff.trim() === "" ? "(no change could be read)" : diff}
</diff>`;
  try {
    const conversation = await model.open({
      system: CHECK_JUDGE_SYSTEM,
      tools: NO_TOOLS,
      maxSteps: 1,
    });
    try {
      const turn = await collectTurn(conversation.send(message, signal ? { signal } : {}));
      return readJudgement(turn.result.text, task);
    } finally {
      await conversation.close();
    }
  } catch (error) {
    return {
      verdict: "none",
      reason: `the judge could not be asked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** A check as one line, for what is recorded. */
export function checkLine(a: Acceptance): string {
  return a.check === "command"
    ? a.run
    : a.check === "files"
      ? `files: ${a.exist.join(", ")}`
      : `review: ${a.criteria}`;
}
