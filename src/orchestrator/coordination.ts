import type { Tool } from "../agent/tools.js";
import type { Model } from "../model/index.js";
import { checkPlan, type Acceptance, type TaskSpec } from "./plan.js";
import { extractJson } from "./planner.js";
import type { OperationalStore, TaskRecord } from "./store.js";

/**
 * How the workers of a run and its orchestrator (the main agent's run) talk
 * while it goes: each worker reports its progress (what it found, did, and
 * ran into), and may ask for more work: its own task or another one done
 * again, or a new task. The orchestrator decides each request; a rejected
 * one comes back to the worker with the reason, an accepted one becomes a
 * task of the plan, said to be a rerun of which task, asked by whom and
 * why, so the plan keeps the trace.
 */

/** What a worker reports while it works. */
export interface ProgressReport {
  readonly summary: string;
  readonly found?: readonly string[];
  readonly done?: readonly string[];
  readonly problems?: readonly string[];
}

/** What a worker asks the orchestrator for. */
export interface WorkRequest {
  readonly runId: string;
  /** The task of the worker asking. */
  readonly from: string;
  readonly worker: string;
  /** `rerun`: a task done again (its own, or another); `new`: a task the plan lacks. */
  readonly kind: "rerun" | "new";
  /** For `rerun`: the task to do again. */
  readonly task?: string;
  /** Why it is needed. */
  readonly reason: string;
  /** What exactly should be done. */
  readonly what: string;
  /** Files or folders it would change, when known. */
  readonly files?: readonly string[];
}

/** The orchestrator's answer to a request. */
export interface WorkDecision {
  readonly accept: boolean;
  readonly reason: string;
  /** The task added, when accepted. */
  readonly added?: { readonly id: string; readonly title: string };
}

/** What a decider sees and says: whether to accept, why, and what the new task needs. */
export interface DeciderVerdict {
  readonly accept: boolean;
  readonly reason: string;
  readonly complexity?: number;
  readonly acceptance?: readonly Acceptance[];
}

export type Decider = (
  request: WorkRequest,
  context: { readonly goal: string; readonly tasks: readonly TaskRecord[] },
) => Promise<DeciderVerdict>;

/** Something a worker said or asked, for an interface to show. */
export type WorkNote =
  | {
      readonly kind: "progress";
      readonly runId: string;
      readonly task: string;
      readonly worker: string;
      readonly report: ProgressReport;
    }
  | { readonly kind: "request"; readonly request: WorkRequest; readonly decision: WorkDecision };

/** Requests a run may accept, at most: more needs a person (or a replan). */
export const MAX_ACCEPTED_REQUESTS = 4;

export class Coordinator {
  constructor(
    private readonly store: OperationalStore,
    private readonly decide: Decider,
    private readonly onNote?: (note: WorkNote) => void,
  ) {}

  /** A worker's progress: kept in the run's events, and told to the interface. */
  progress(runId: string, task: string, worker: string, report: ProgressReport): void {
    this.store.event(runId, "progress", { worker, ...report }, task);
    this.onNote?.({ kind: "progress", runId, task, worker, report });
  }

  /** Decides a worker's request: rejected with a reason, or added to the plan. */
  async request(request: WorkRequest): Promise<WorkDecision> {
    const decision = await this.#decide(request);
    this.store.event(
      request.runId,
      "work_request",
      {
        worker: request.worker,
        kind: request.kind,
        ...(request.task ? { task: request.task } : {}),
        reason: request.reason,
        what: request.what,
        accept: decision.accept,
        answer: decision.reason,
        ...(decision.added ? { added: decision.added.id } : {}),
      },
      request.from,
    );
    this.onNote?.({ kind: "request", request, decision });
    return decision;
  }

  async #decide(request: WorkRequest): Promise<WorkDecision> {
    const run = this.store.run(request.runId);
    if (!run) return { accept: false, reason: "the run is not known" };
    const tasks = this.store.tasks(request.runId);
    const accepted = this.store
      .events(request.runId)
      .filter((e) => e.kind === "work_request" && e.data.accept === true).length;
    if (accepted >= MAX_ACCEPTED_REQUESTS) {
      return {
        accept: false,
        reason: `this run already took ${String(accepted)} requests, the most allowed: finish your task with what there is, and say what is missing in your report`,
      };
    }
    const target =
      request.kind === "rerun"
        ? tasks.find((t) => t.id === (request.task ?? request.from))
        : undefined;
    if (request.kind === "rerun") {
      if (!target) return { accept: false, reason: `there is no task ${request.task ?? ""}` };
      if (target.state === "running" && target.id !== request.from) {
        return { accept: false, reason: `${target.id} is still running: wait for its result` };
      }
      if (target.state === "pending" || target.state === "ready") {
        return { accept: false, reason: `${target.id} has not run yet: it will run as planned` };
      }
    }
    let verdict: DeciderVerdict;
    try {
      verdict = await this.decide(request, { goal: run.plan.goal, tasks });
    } catch (error) {
      return {
        accept: false,
        reason: `the orchestrator could not decide (${error instanceof Error ? error.message : String(error)}): go on with your task`,
      };
    }
    if (!verdict.accept) return { accept: false, reason: verdict.reason };

    const from = tasks.find((t) => t.id === request.from)?.spec;
    const spec = requestedTask(
      request,
      verdict,
      target?.spec,
      from,
      new Set(tasks.map((t) => t.id)),
    );
    const plan = { ...run.plan, tasks: [...run.plan.tasks, spec] };
    const checked = checkPlan(plan);
    if (!checked.ok) {
      return {
        accept: false,
        reason: `the task it would add is not valid (${checked.problems.join("; ")}): go on with your task`,
      };
    }
    this.store.replan(request.runId, checked.plan, checked.order, [spec], []);
    return { accept: true, reason: verdict.reason, added: { id: spec.id, title: spec.title } };
  }
}

/** The task an accepted request adds: a rerun of a task, or a new one, saying why and for whom. */
export function requestedTask(
  request: WorkRequest,
  verdict: DeciderVerdict,
  target: TaskSpec | undefined,
  from: TaskSpec | undefined,
  used: ReadonlySet<string>,
): TaskSpec {
  const unique = (base: string) => {
    const stem = base.slice(0, 40);
    for (let n = 2; ; n++) {
      const id = `${stem}-${String(n)}`;
      if (!used.has(id)) return id;
    }
  };
  const why = `\n\n## Why this task was added\n${request.worker} (on ${request.from}) asked: ${request.reason}. The orchestrator accepted: ${verdict.reason}.\n\n## What to do\n${request.what}`;
  if (request.kind === "rerun" && target) {
    return {
      ...target,
      id: unique(`${target.id}-again`),
      title: `Again: ${target.title}`.slice(0, 120),
      description: `${target.description}${why}`,
      dependsOn: [],
      ...(request.files && request.files.length > 0 ? { touches: [...request.files] } : {}),
      ...(verdict.acceptance && verdict.acceptance.length > 0
        ? { acceptance: [...verdict.acceptance] }
        : {}),
    };
  }
  const base = from ?? target;
  return {
    id: unique(`${request.from}-more`),
    title: request.what.split("\n", 1)[0]?.slice(0, 100) ?? "More work",
    description: `${request.what}${why}`,
    kind: base?.kind ?? "backend",
    dependsOn: [],
    complexity: Math.min(5, Math.max(1, Math.round(verdict.complexity ?? base?.complexity ?? 2))),
    capabilities: base?.capabilities ? [...base.capabilities] : ["code"],
    touches:
      request.files && request.files.length > 0 ? [...request.files] : [...(base?.touches ?? [])],
    acceptance:
      verdict.acceptance && verdict.acceptance.length > 0
        ? [...verdict.acceptance]
        : [...(base?.acceptance ?? [{ check: "files", exist: ["."] }])],
    parallelSafe: base?.parallelSafe ?? true,
  };
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The tools a worker uses to talk to the orchestrator. */
export function coordinationTools(
  coordinator: Coordinator,
  runId: string,
  task: string,
  worker: string,
): Tool[] {
  return [
    {
      name: "report_progress",
      description:
        "Tells the orchestrator how your task goes: a short summary, and what you found, did or ran into. Use it at milestones (what you found after looking around, what you finished, a problem), not for every step.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One or two sentences." },
          found: { type: "array", items: { type: "string" } },
          done: { type: "array", items: { type: "string" } },
          problems: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      writes: false,
      run: (input) => {
        coordinator.progress(runId, task, worker, {
          summary: String(input.summary),
          ...(list(input.found).length > 0 ? { found: list(input.found) } : {}),
          ...(list(input.done).length > 0 ? { done: list(input.done) } : {}),
          ...(list(input.problems).length > 0 ? { problems: list(input.problems) } : {}),
        });
        return "Reported to the orchestrator.";
      },
    },
    {
      name: "request_work",
      description:
        "Asks the orchestrator for work your task cannot do alone: a task done again (yours, or another that is finished, when its result fell short or must be redone), or a new task the plan lacks. The orchestrator decides: if it accepts, a worker does it as a task of the plan; if not, you get the reason and go on with your own task. Do not use it for what you can do yourself within your task.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["rerun", "new"] },
          task: {
            type: "string",
            description: "For rerun: the task to do again (default: yours).",
          },
          reason: { type: "string", description: "Why it is needed." },
          what: { type: "string", description: "What exactly should be done." },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Files it would change.",
          },
        },
        required: ["kind", "reason", "what"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input) => {
        const decision = await coordinator.request({
          runId,
          from: task,
          worker,
          kind: input.kind === "rerun" ? "rerun" : "new",
          ...(typeof input.task === "string" && input.task !== "" ? { task: input.task } : {}),
          reason: String(input.reason),
          what: String(input.what),
          ...(list(input.files).length > 0 ? { files: list(input.files) } : {}),
        });
        return decision.accept
          ? `Accepted by the orchestrator: ${decision.reason}. It is task ${decision.added?.id ?? "?"} of the plan now; a worker will do it. Go on with your own task.`
          : `Rejected by the orchestrator: ${decision.reason}. Do not ask again for the same; go on with your own task.`;
      },
    },
  ];
}

export const DECIDER_SYSTEM = `You are the orchestrator of a run of Grafeno Agent: several workers do the tasks of a plan. A worker asks for more work. Decide whether it is worth doing now.

Accept only when the plan's goal needs it and the worker cannot do it within its own task: a finished task whose result fell short or must be redone with what was learned since, or a missing piece the goal needs. Reject what is out of scope, duplicates a task that is planned or running, or only polishes. Every accepted task spends the user's plan.

Answer with JSON only:
{ "accept": true | false, "reason": "one sentence", "complexity": 1 to 5, "acceptance": [ { "check": "command", "run": "..." } or { "check": "files", "exist": ["..."] } ] }
"complexity" and "acceptance" only when you accept; acceptance must be checkable by code.`;

/** A decider that asks a model (the planner's), with the plan and the request. */
export function modelDecider(make: () => Promise<Model>): Decider {
  return async (request, { goal, tasks }) => {
    const model = await make();
    const conversation = await model.open({
      system: DECIDER_SYSTEM,
      // It only answers: no tools.
      tools: {
        tools: [],
        call: () => Promise.resolve({ content: "No tools here.", isError: true }),
      },
    });
    try {
      const lines = tasks.map((t) => `- ${t.id} [${t.state}] ${t.spec.title}`);
      const message = [
        `Goal: ${goal}`,
        `Tasks:\n${lines.join("\n")}`,
        `Request from ${request.worker} (task ${request.from}): ${request.kind}${request.task ? ` of ${request.task}` : ""}`,
        `Reason: ${request.reason}`,
        `What: ${request.what}`,
        request.files ? `Files: ${request.files.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      let text = "";
      for await (const event of conversation.send(message)) {
        if (event.type === "text") text += event.text;
      }
      const json = extractJson(text) as Partial<DeciderVerdict> | undefined;
      if (!json || typeof json.accept !== "boolean") {
        return { accept: false, reason: "the orchestrator's answer was not clear" };
      }
      return {
        accept: json.accept,
        reason:
          typeof json.reason === "string" && json.reason !== ""
            ? json.reason
            : json.accept
              ? "needed"
              : "not needed now",
        ...(typeof json.complexity === "number" ? { complexity: json.complexity } : {}),
        ...(Array.isArray(json.acceptance) ? { acceptance: json.acceptance } : {}),
      };
    } finally {
      await conversation.close();
    }
  };
}

/** What workers reported and asked in a run, as lines for the main agent and the person. */
export function describeCoordination(store: OperationalStore, runId: string): string[] {
  const lines: string[] = [];
  for (const event of store.events(runId)) {
    if (event.kind === "progress") {
      const d = event.data;
      const extra = [
        ...list(d.found).map((f) => `found: ${f}`),
        ...list(d.done).map((f) => `did: ${f}`),
        ...list(d.problems).map((f) => `problem: ${f}`),
      ];
      lines.push(
        `- ${event.taskId ?? "?"} reported: ${String(d.summary)}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}`,
      );
    } else if (event.kind === "work_request") {
      const d = event.data;
      lines.push(
        `- ${event.taskId ?? "?"} asked for ${d.kind === "rerun" ? `a rerun of ${typeof d.task === "string" ? d.task : (event.taskId ?? "?")}` : "a new task"} (${String(d.reason)}): ${d.accept === true ? `accepted as ${String(d.added)}` : "rejected"}, ${String(d.answer)}`,
      );
    }
  }
  return lines;
}
