import { isAbsolute, normalize } from "node:path";
import { commandPermission } from "../tools/command.js";

/**
 * A plan: what the user asked for, broken into tasks with their
 * dependencies (a DAG), each with acceptance that code can check.
 */
export interface Plan {
  readonly goal: string;
  readonly tasks: readonly TaskSpec[];
  readonly risks: readonly string[];
}

export const TASK_KINDS = [
  "architecture",
  "backend",
  "frontend",
  "tests",
  "docs",
  "refactor",
  "debug",
  "review",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** How capable a model a task needs: mapped to real models by the router, never named here. */
export const TIERS = ["deep", "standard", "light"] as const;
export type Tier = (typeof TIERS)[number];

export interface TaskSpec {
  /** Unique in the plan: lower case letters, digits and dashes. */
  readonly id: string;
  readonly title: string;
  /** What to do, for the worker. */
  readonly description: string;
  readonly kind: TaskKind;
  /** Tasks that must be completed first. */
  readonly dependsOn: readonly string[];
  /** 1 (trivial) to 5 (hard). */
  readonly complexity: number;
  /** What the worker needs: "code", "shell", "web"… */
  readonly capabilities: readonly string[];
  /** Files or folders it expects to change, inside the project. */
  readonly touches: readonly string[];
  /** How code checks it is done: at least one check that is not a review. */
  readonly acceptance: readonly Acceptance[];
  /** Whether it can run beside others that do not share its files. */
  readonly parallelSafe: boolean;
  /** The planner's advice; the router has the last word. */
  readonly recommended?: { readonly tier: Tier; readonly effort?: string };
  /**
   * Who the run's leader gave the task to: a provider, and a model of it
   * when it named one. The router follows it when that provider is ready
   * and can take the task.
   */
  readonly assignee?: { readonly provider: string; readonly model?: string };
}

export type Acceptance =
  /** A command run in the task's workspace must exit 0: typecheck, lint, tests, build. */
  | { readonly check: "command"; readonly run: string }
  /** These files must exist afterwards. */
  | { readonly check: "files"; readonly exist: readonly string[] }
  /** Another worker reviews against these criteria: extra evidence, never enough alone. */
  | { readonly check: "review"; readonly criteria: string };

/** The result of checking a plan: the plan, or every problem found. */
export type PlanCheck =
  | { readonly ok: true; readonly plan: Plan; readonly order: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_TASKS = 40;

/**
 * Checks a plan by code, whatever wrote it: its shape, unique ids, known
 * dependencies, no cycles, acceptance that code can check, files inside the
 * project, and commands the policy allows. Returns the plan with an order
 * that respects the dependencies, or every problem found.
 */
export function checkPlan(input: unknown): PlanCheck {
  const problems: string[] = [];
  if (!isObject(input)) return { ok: false, problems: ["the plan is not an object"] };
  const goal = text(input.goal);
  if (goal === "") problems.push("the plan has no goal");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return { ok: false, problems: [...problems, "the plan has no tasks"] };
  }
  if (input.tasks.length > MAX_TASKS) {
    problems.push(`the plan has ${String(input.tasks.length)} tasks; at most ${String(MAX_TASKS)}`);
  }
  const tasks: TaskSpec[] = [];
  const seen = new Set<string>();
  input.tasks.forEach((raw: unknown, index: number) => {
    const task = readTask(raw, index, problems);
    if (!task) return;
    if (seen.has(task.id)) problems.push(`task id "${task.id}" is used twice`);
    seen.add(task.id);
    tasks.push(task);
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) problems.push(`task "${task.id}" depends on itself`);
      else if (!seen.has(dependency)) {
        problems.push(`task "${task.id}" depends on "${dependency}", which is not in the plan`);
      }
    }
  }
  const order = problems.length === 0 ? topologicalOrder(tasks) : undefined;
  if (order && "cycle" in order) {
    problems.push(`the dependencies form a cycle: ${order.cycle.join(" → ")}`);
  }
  if (problems.length > 0 || !order || "cycle" in order) return { ok: false, problems };
  const risks = Array.isArray(input.risks) ? input.risks.map(text).filter(Boolean) : [];
  return { ok: true, plan: { goal, tasks, risks }, order: order.order };
}

function readTask(raw: unknown, index: number, problems: string[]): TaskSpec | undefined {
  const where = `task ${String(index + 1)}`;
  if (!isObject(raw)) {
    problems.push(`${where} is not an object`);
    return undefined;
  }
  const id = text(raw.id);
  const name = id === "" ? where : `task "${id}"`;
  if (!ID.test(id)) problems.push(`${where} has no valid id (lower case, digits, dashes): "${id}"`);
  const title = text(raw.title);
  if (title === "") problems.push(`${name} has no title`);
  const kind = text(raw.kind);
  if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    problems.push(`${name} has an unknown kind "${kind}" (one of ${TASK_KINDS.join(", ")})`);
  }
  const complexity = typeof raw.complexity === "number" ? Math.round(raw.complexity) : NaN;
  if (!(complexity >= 1 && complexity <= 5))
    problems.push(`${name} needs a complexity from 1 to 5`);
  const touches = strings(raw.touches);
  for (const path of touches) {
    const clean = normalize(path);
    if (isAbsolute(path) || clean.startsWith("..")) {
      problems.push(`${name} touches "${path}", outside the project`);
    }
  }
  const acceptance = readAcceptance(raw.acceptance, name, problems);
  if (acceptance.length === 0) {
    problems.push(`${name} has no acceptance: say how code can check it is done`);
  } else if (acceptance.every((a) => a.check === "review")) {
    problems.push(`${name} is accepted only by a review: add a command or files to check`);
  }
  const recommended = readRecommended(raw.recommended, name, problems);
  const assignee = readAssignee(raw.assign);
  return {
    id,
    title,
    description: text(raw.description) || title,
    kind: kind as TaskKind,
    dependsOn: strings(raw.dependsOn),
    complexity,
    capabilities: strings(raw.capabilities),
    touches,
    acceptance,
    parallelSafe: raw.parallelSafe !== false,
    ...(recommended ? { recommended } : {}),
    ...(assignee ? { assignee } : {}),
  };
}

/** "provider" or "provider/model" (a model's own id may have slashes too: "lmstudio/qwen/qwen3"). */
export function readAssignee(raw: unknown): TaskSpec["assignee"] | undefined {
  const value = text(raw);
  if (value === "") return undefined;
  const at = value.indexOf("/");
  const provider = (at < 0 ? value : value.slice(0, at)).trim();
  const model = at < 0 ? "" : value.slice(at + 1).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) return undefined;
  return { provider, ...(model ? { model } : {}) };
}

/** Checks read with the plan's rules (forbidden commands refused), with what was wrong in them. */
export function readChecks(
  raw: unknown,
  name: string,
): { acceptance: Acceptance[]; problems: string[] } {
  const problems: string[] = [];
  const acceptance = readAcceptance(raw, name, problems);
  return { acceptance, problems };
}

function readAcceptance(raw: unknown, name: string, problems: string[]): Acceptance[] {
  if (!Array.isArray(raw)) return [];
  const out: Acceptance[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (item.check === "command") {
      const run = text(item.run);
      if (run === "") {
        problems.push(`${name} has a command check without a command`);
        continue;
      }
      const decision = commandPermission(run);
      if (decision.permission === "never") {
        problems.push(`${name} checks with a forbidden command "${run}": ${decision.reason ?? ""}`);
        continue;
      }
      out.push({ check: "command", run });
    } else if (item.check === "files") {
      const exist = strings(item.exist);
      if (exist.length > 0) out.push({ check: "files", exist });
    } else if (item.check === "review") {
      const criteria = text(item.criteria);
      if (criteria !== "") out.push({ check: "review", criteria });
    } else {
      problems.push(`${name} has an unknown check "${String(item.check)}"`);
    }
  }
  return out;
}

function readRecommended(
  raw: unknown,
  name: string,
  problems: string[],
): TaskSpec["recommended"] | undefined {
  if (!isObject(raw)) return undefined;
  const tier = text(raw.tier);
  if (!(TIERS as readonly string[]).includes(tier)) {
    problems.push(`${name} recommends an unknown tier "${tier}" (one of ${TIERS.join(", ")})`);
    return undefined;
  }
  const effort = text(raw.effort);
  return { tier: tier as Tier, ...(effort === "" ? {} : { effort }) };
}

/**
 * An order of the tasks where each comes after what it depends on (Kahn's
 * algorithm, stable by plan order), or a cycle when there is none.
 */
export function topologicalOrder(
  tasks: readonly Pick<TaskSpec, "id" | "dependsOn">[],
): { order: string[] } | { cycle: string[] } {
  const waiting = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  const order: string[] = [];
  while (waiting.size > 0) {
    const free = [...waiting].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (free.length === 0) return { cycle: findCycle(tasks, new Set(waiting.keys())) };
    for (const id of free) {
      order.push(id);
      waiting.delete(id);
      for (const deps of waiting.values()) deps.delete(id);
    }
  }
  return { order };
}

function findCycle(
  tasks: readonly Pick<TaskSpec, "id" | "dependsOn">[],
  left: Set<string>,
): string[] {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn.filter((d) => left.has(d))]));
  const start = [...left][0] ?? "";
  const path: string[] = [];
  const index = new Map<string, number>();
  let at = start;
  while (!index.has(at)) {
    index.set(at, path.length);
    path.push(at);
    at = deps.get(at)?.[0] ?? start;
  }
  return [...path.slice(index.get(at)), at];
}

/** Tasks whose dependencies are all in `done`, and that are not done or running. */
export function readyTasks(
  plan: Plan,
  done: ReadonlySet<string>,
  busy: ReadonlySet<string> = new Set(),
): TaskSpec[] {
  return plan.tasks.filter(
    (task) => !done.has(task.id) && !busy.has(task.id) && task.dependsOn.every((d) => done.has(d)),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((s) => s !== "") : [];
}
