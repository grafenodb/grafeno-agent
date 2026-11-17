import type { OperationalStore, Run, RunEvent } from "../../orchestrator/store.js";
import type { Field } from "../ui/inspector.js";
import type { Row } from "../ui/table.js";

/**
 * A project's runs and their tasks, read from the runs' own store: what
 * each recorded (states, attempts, models, outcomes, reasons). Tool calls
 * are not kept there (they show live in the agents panel), so they are
 * not shown here as if they were.
 */

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

function seconds(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.round(ms / 1000);
  return s < 120 ? `${String(s)} s` : `${String(Math.round(s / 60))} min`;
}

const toneOf = (state: string): Row["tone"] =>
  state === "completed"
    ? "success"
    : state === "failed"
      ? "error"
      : state === "running" || state === "review" || state === "waiting"
        ? "warning"
        : undefined;

/** Each run as a row: its request, state, tasks done and when it last changed. */
export function runRows(store: OperationalStore): Row[] {
  return store.runs().map((run) => {
    const tasks = store.tasks(run.id);
    const done = tasks.filter((t) => t.state === "completed").length;
    const failed = tasks.filter((t) => t.state === "failed").length;
    const tone = toneOf(run.state);
    return {
      id: run.id,
      cells: {
        request: run.request,
        state: run.state,
        tasks: `${String(done)}/${String(tasks.length)}${failed > 0 ? ` (${String(failed)} failed)` : ""}`,
        updated: when(run.updated),
      },
      ...(tone ? { tone } : {}),
    };
  });
}

/** A run's tasks as rows: state, attempts, the model of the last one. */
export function taskRows(store: OperationalStore, runId: string): Row[] {
  return store.tasks(runId).map((task) => {
    const tone = toneOf(task.state);
    return {
      id: task.id,
      cells: {
        task: task.spec.title || task.id,
        state: task.state,
        tries: String(task.attempts),
        model: task.model ?? "",
      },
      ...(tone ? { tone } : {}),
    };
  });
}

/** What is known of a run. */
export function runFields(run: Run, store: OperationalStore): Field[] {
  const tasks = store.tasks(run.id);
  return [
    { label: "Request", value: run.request },
    {
      label: "State",
      value: run.state,
      tone: run.state === "completed" ? "success" : run.state === "failed" ? "error" : "muted",
    },
    { label: "Started", value: when(run.created) },
    { label: "Last change", value: when(run.updated) },
    { label: "Took", value: seconds(run.created, run.updated) },
    { label: "Tasks", value: String(tasks.length) },
    { label: "Base commit", value: run.baseCommit?.slice(0, 12) ?? "unknown" },
  ];
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

/** What a task recorded: its spec, each attempt (model, outcome, time, tokens) and why it ended. */
export function taskFields(store: OperationalStore, runId: string, taskId: string): Field[] {
  const task = store.task(runId, taskId);
  if (!task) return [{ label: "Task", value: "unknown" }];
  const events = store.events(runId).filter((e) => e.taskId === taskId);
  const attempts = events.filter((e) => e.kind === "attempt_metrics");
  const ended = events.filter((e) => e.kind === "attempt_ended");
  const route = events.filter((e) => e.kind === "route_decision").at(-1);
  const checks = events.filter((e) => e.kind === "verified");
  const fields: Field[] = [
    { label: "Task", value: task.spec.title || task.id },
    { label: "Kind", value: `${task.spec.kind} · complexity ${String(task.spec.complexity)}` },
    {
      label: "State",
      value: task.state,
      tone: task.state === "completed" ? "success" : task.state === "failed" ? "error" : "muted",
    },
    { label: "Why", value: task.reason?.split("\n")[0] ?? "—" },
    { label: "Checks", value: checksText(checks) },
    { label: "Routed", value: str(route?.data.reason) ?? "unknown" },
  ];
  attempts.forEach((a, i) => {
    fields.push({ label: `Attempt ${String(i + 1)}`, value: attemptText(a, ended[i]) });
  });
  fields.push({
    label: "Tool calls",
    value: "not kept in the run: they show live in the agents panel",
    tone: "muted",
  });
  return fields;
}

function checksText(checks: readonly RunEvent[]): string {
  if (checks.length === 0) return "not run";
  return checks.map((c) => (c.data.ok === true ? "✓" : "✗")).join(" ");
}

function attemptText(metrics: RunEvent, end: RunEvent | undefined): string {
  const model = str(metrics.data.model) ?? "unknown";
  const outcome = str(end?.data.status) ?? str(metrics.data.outcome) ?? "unknown";
  const ms = num(metrics.data.ms);
  const input = num(metrics.data.inputTokens);
  const output = num(metrics.data.outputTokens);
  const tokens =
    input === undefined || output === undefined
      ? ""
      : ` · ${String(input)} in / ${String(output)} out`;
  return `${model} · ${outcome}${ms === undefined ? "" : ` · ${String(Math.round(ms / 1000))} s`}${tokens}`;
}
