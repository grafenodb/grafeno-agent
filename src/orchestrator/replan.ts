import type { Model, Usage } from "../model/index.js";
import { checkPlan, TASK_KINDS, TIERS, type Plan, type PlanCheck, type TaskSpec } from "./plan.js";
import { makePlan } from "./planner.js";
import type { OperationalStore, TaskRecord } from "./store.js";

/**
 * Replanning only what failed (phase D3, brief §D.1). When a task fails for
 * good, the planner is asked for new tasks in place of it and of the tasks
 * that depend on it, and only those. Completed tasks are kept as they are:
 * new tasks may build on them but never change them. Code checks the
 * answer: a valid DAG with what is kept, new ids only, no task depending on
 * what is replaced, and no more tasks than the work needs. A run is
 * replanned a bounded number of times. The proposal is applied apart, so a
 * person can be asked first (always, except in the extended mode).
 */

/** Replans per run, at most. */
export const MAX_REPLANS = 2;

/** New tasks a replan may add beyond the ones it replaces. */
const EXTRA_TASKS = 3;

export class ReplanRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplanRefused";
  }
}

export interface ReplanProposal {
  readonly runId: string;
  /** The failed tasks and their dependants, replaced. */
  readonly replaced: readonly string[];
  /** The new tasks, in place of them. */
  readonly added: readonly TaskSpec[];
  /** The run's whole plan after it: what is kept, and what is added. */
  readonly plan: Plan;
  readonly order: readonly string[];
  /** Answers the planner gave (1 when the first was valid). */
  readonly attempts: number;
  readonly usage: Usage;
}

export const REPLAN_SYSTEM = `You are the planner of Grafeno Agent, revising part of a plan after a task failed for good.

You are given the run's goal, the completed tasks (done: keep them, never change them), the task that failed with why, and the tasks that depended on it.

Answer with JSON only, in one \`\`\`json block: {"goal": "...", "risks": ["..."], "tasks": [ ... ]}, where "tasks" holds only the NEW tasks that replace the failed task and its dependants, each with this shape:
{"id": "kebab-case, new: never one already used", "title": "...", "description": "...", "kind": one of ${TASK_KINDS.join(", ")}, "dependsOn": [ids of completed tasks or of other new tasks], "complexity": 1-5, "capabilities": ["code"], "touches": ["paths"], "acceptance": [{"check": "command", "run": "..."} or {"check": "files", "exist": ["..."]}], "parallelSafe": true or false, "recommended": {"tier": one of ${TIERS.join(", ")}, "effort": "low|medium|high"} (optional)}

- Address why the task failed: a different approach, a smaller step, a missing prerequisite; not the same task again.
- Redo only what is needed: the failed task and what depended on it. Do not re-plan completed work.
- Keep the acceptance checks objective and runnable by code.`;

/** The tasks a replan replaces: every failed task, and every task that depends on one, not completed. */
export function affectedBy(tasks: readonly TaskRecord[]): {
  failed: TaskRecord[];
  affected: TaskRecord[];
} {
  const failed = tasks.filter((t) => t.state === "failed");
  const ids = new Set(failed.map((t) => t.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (ids.has(task.id) || task.state === "completed" || task.state === "cancelled") continue;
      if (task.spec.dependsOn.some((d) => ids.has(d))) {
        ids.add(task.id);
        grew = true;
      }
    }
  }
  return { failed, affected: tasks.filter((t) => ids.has(t.id)) };
}

/** Asks the planner for new tasks in place of the failed ones; nothing is applied yet. */
export async function proposeReplan(
  store: OperationalStore,
  runId: string,
  model: Model,
  options: { readonly signal?: AbortSignal; readonly maxReplans?: number } = {},
): Promise<ReplanProposal> {
  const run = store.run(runId);
  if (!run) throw new ReplanRefused(`No run ${runId}`);
  const tasks = store.tasks(runId);
  if (tasks.some((t) => t.state === "running")) {
    throw new ReplanRefused("A task is still running: replan once the run has stopped");
  }
  const done = store.events(runId).filter((e) => e.kind === "replanned").length;
  const max = options.maxReplans ?? MAX_REPLANS;
  if (done >= max) {
    throw new ReplanRefused(
      `This run was replanned ${String(done)} times, the most allowed: a person should look at it`,
    );
  }
  const { failed, affected } = affectedBy(tasks);
  if (failed.length === 0) throw new ReplanRefused("No task failed: there is nothing to replan");

  const kept = tasks.filter((t) => t.state === "completed").map((t) => t.spec);
  const used = new Set(tasks.map((t) => t.id));
  const replacing = new Set(affected.map((t) => t.id));
  const most = affected.length + EXTRA_TASKS;
  const check = (json: unknown): PlanCheck => {
    const added = (json as { tasks?: unknown } | undefined)?.tasks;
    if (!Array.isArray(added) || added.length === 0) {
      return { ok: false, problems: ["the answer has no new tasks"] };
    }
    const problems: string[] = [];
    if (added.length > most) {
      problems.push(
        `${String(added.length)} new tasks for ${String(affected.length)} replaced: at most ${String(most)}; redo only what is needed`,
      );
    }
    for (const raw of added) {
      const id = (raw as { id?: unknown }).id;
      if (typeof id === "string" && used.has(id)) {
        problems.push(`task id "${id}" is already used in this run: give the new task a new id`);
      }
      const deps = (raw as { dependsOn?: unknown }).dependsOn;
      for (const dep of Array.isArray(deps) ? deps : []) {
        if (typeof dep === "string" && replacing.has(dep)) {
          problems.push(`a new task depends on "${dep}", which is being replaced`);
        }
      }
    }
    // The whole plan must hold: what is kept, and what is added.
    const whole = checkPlan({ ...(json as object), tasks: [...kept, ...(added as unknown[])] });
    if (!whole.ok) problems.push(...whole.problems);
    if (problems.length > 0 || !whole.ok) return { ok: false, problems };
    return whole;
  };

  const describe = (t: TaskSpec) =>
    `- ${t.id} (${t.kind}): ${t.title}. Touches ${t.touches.join(", ") || "-"}.`;
  const request = [
    `Goal of the run: ${run.plan.goal}`,
    `The user's request: ${run.request}`,
    "",
    "Completed (keep, never change; new tasks may depend on them):",
    ...(kept.length > 0 ? kept.map(describe) : ["- none"]),
    "",
    "Failed for good:",
    ...failed.map((t) => `${describe(t.spec)} Why: ${t.reason ?? "unknown"}`),
    "",
    "Depending on it, to redo or revise:",
    ...(affected.length > failed.length
      ? affected.filter((t) => t.state !== "failed").map((t) => describe(t.spec))
      : ["- none"]),
  ].join("\n");

  const planned = await makePlan(
    { request },
    {
      model,
      system: REPLAN_SYSTEM,
      check,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const keptIds = new Set(kept.map((t) => t.id));
  return {
    runId,
    replaced: affected.map((t) => t.id),
    added: planned.plan.tasks.filter((t) => !keptIds.has(t.id)),
    plan: planned.plan,
    order: planned.order,
    attempts: planned.attempts,
    usage: planned.usage,
  };
}

/** Applies a proposal: the replaced tasks are cancelled as replaced, the new ones added. */
export function applyReplan(store: OperationalStore, proposal: ReplanProposal): void {
  store.replan(proposal.runId, proposal.plan, proposal.order, proposal.added, proposal.replaced);
}

/** A proposal as lines for a person. */
export function describeReplan(proposal: ReplanProposal): string[] {
  return [
    `Replace ${proposal.replaced.join(", ")} with:`,
    ...proposal.added.map(
      (t) =>
        `  ${t.id.padEnd(22)} ${t.kind.padEnd(12)} ${t.title}${t.dependsOn.length > 0 ? `  after ${t.dependsOn.join(", ")}` : ""}`,
    ),
  ];
}
