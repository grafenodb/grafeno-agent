import { describeCall } from "../app/session.js";
import type { TaskState } from "../orchestrator/states.js";
import type { ActiveWorker, WorkerActivity } from "../orchestrator/workers.js";

/** One line of what a sub-agent did: its words, or a tool it used. */
export type AgentLine =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly label: string;
      readonly state: "running" | "done" | "failed";
      readonly detail?: string;
    };

/**
 * A sub-agent: a worker the main agent's run started for one task. The
 * interface shows it, read-only: it takes no prompts, the main agent
 * orchestrates it.
 */
export interface SubAgent {
  /** The task it works on: one sub-agent per task, across its attempts. */
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly state: TaskState;
  /** The worker of the attempt now (or the last one), as the pool names it. */
  readonly worker?: string;
  readonly model?: string;
  readonly effort?: string;
  /** What it is doing now, in a few words. */
  readonly doing?: string;
  /** Why it is waiting, failed or in review. */
  readonly reason?: string;
  readonly lines: readonly AgentLine[];
  /** The tier the router gave it, and the exact model answering, when it said. */
  readonly tier?: string;
  readonly exactModel?: string;
  /** When its current attempt started. */
  readonly started?: Date;
  /** Tokens it spent, over its attempts. */
  readonly tokens?: { readonly input: number; readonly output: number; readonly cache: number };
  /** How full its context is now. */
  readonly context?: { readonly used: number; readonly window?: number };
  /** Its own folder (a worktree) and branch. */
  readonly folder?: string;
  readonly branch?: string;
  /** What it last told the orchestrator. */
  readonly lastReport?: string;
}

/** Lines kept per sub-agent on screen. */
const KEEP = 400;

/** The run's tasks, as sub-agents: new ones added, known ones kept with their lines. */
export function withTasks(
  agents: readonly SubAgent[],
  runId: string,
  tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: TaskState;
    readonly reason?: string;
  }[],
  where?: (taskId: string) => { folder: string; branch: string },
): SubAgent[] {
  const others = agents.filter((a) => a.runId !== runId);
  const mine = tasks.map((task) => {
    const known = agents.find((a) => a.runId === runId && a.id === task.id);
    const fresh: SubAgent = {
      id: task.id,
      runId,
      title: task.title,
      state: task.state,
      lines: [],
      ...(where ? where(task.id) : {}),
    };
    return settle(known ?? fresh, task.state, task.reason, task.title);
  });
  return [...others, ...mine];
}

/** What a sub-agent told the orchestrator, on its lines and as its last report. */
export function withReport(
  agents: readonly SubAgent[],
  runId: string,
  task: string,
  text: string,
): SubAgent[] {
  return agents.map((a) =>
    a.runId === runId && a.id === task
      ? {
          ...a,
          lastReport: text,
          lines: [
            ...a.lines,
            { kind: "text" as const, text: `\n**To the orchestrator:** ${text}\n` },
          ].slice(-KEEP),
        }
      : a,
  );
}

/** A task changed state. */
export function withState(
  agents: readonly SubAgent[],
  runId: string,
  task: string,
  state: TaskState,
  reason?: string,
): SubAgent[] {
  return agents.map((a) => (a.runId === runId && a.id === task ? settle(a, state, reason) : a));
}

/** Who works on each task now: its worker, model and effort. */
export function withWorkers(
  agents: readonly SubAgent[],
  runId: string,
  workers: readonly ActiveWorker[],
): SubAgent[] {
  return agents.map((a) => {
    const worker = workers.find((w) => w.task === a.id);
    if (a.runId !== runId || !worker) return a;
    return {
      ...without(a, "effort"),
      worker: worker.name,
      model: worker.model,
      tier: worker.tier,
      started: worker.started,
      ...(worker.effort ? { effort: worker.effort } : {}),
    };
  });
}

/** One thing a worker did, added to its sub-agent's lines. */
export function withActivity(agents: readonly SubAgent[], activity: WorkerActivity): SubAgent[] {
  return agents.map((a) => {
    if (a.runId !== activity.runId || a.id !== activity.task) return a;
    const event = activity.event;
    let lines: readonly AgentLine[];
    let doing: string;
    switch (event.type) {
      case "text": {
        const last = a.lines.at(-1);
        lines =
          last?.kind === "text"
            ? [...a.lines.slice(0, -1), { kind: "text", text: last.text + event.text }]
            : [...a.lines, { kind: "text", text: event.text }];
        doing = "writing";
        break;
      }
      case "tool_call": {
        const label = describeCall(event.call);
        lines = [...a.lines, { kind: "tool", id: event.call.id, label, state: "running" }];
        doing = label.split("\n", 1)[0] ?? label;
        break;
      }
      case "tool_result": {
        const failed = event.outcome.isError === true;
        lines = a.lines.map((line) =>
          line.kind === "tool" && line.id === event.callId
            ? {
                ...line,
                state: failed ? "failed" : "done",
                ...(failed
                  ? { detail: (event.outcome.content.split("\n", 1)[0] ?? "").slice(0, 160) }
                  : {}),
              }
            : line,
        );
        doing = "thinking";
        break;
      }
      case "done": {
        const usage = event.result.usage;
        const before = a.tokens ?? { input: 0, output: 0, cache: 0 };
        return {
          ...a,
          tokens: {
            input: before.input + usage.inputTokens,
            output: before.output + usage.outputTokens,
            cache: before.cache + usage.cacheReadTokens + usage.cacheWriteTokens,
          },
        };
      }
      case "context":
        return {
          ...a,
          context: {
            used: event.used,
            ...(event.window === undefined ? {} : { window: event.window }),
          },
        };
      case "model_info":
        return { ...a, exactModel: event.model };
      default:
        return a;
    }
    return { ...a, worker: a.worker ?? activity.worker, lines: lines.slice(-KEEP), doing };
  });
}

/** A sub-agent in a new state, with what it does (or why it stopped) to match. */
function settle(agent: SubAgent, state: TaskState, reason?: string, title?: string): SubAgent {
  const next = without(agent, "reason", "doing");
  return {
    ...next,
    ...(title === undefined ? {} : { title }),
    state,
    ...(reason ? { reason } : {}),
    doing:
      state === "running"
        ? agent.state === "running" && agent.doing
          ? agent.doing
          : "starting"
        : doneLabel(state),
  };
}

/** A copy without these optional fields. */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy as Omit<T, K>;
}

function doneLabel(state: TaskState): string {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "review":
      return "waiting for a person";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "ready":
      return "ready to start";
    default:
      return "waiting";
  }
}
