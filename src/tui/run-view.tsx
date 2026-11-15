import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { TaskState } from "../orchestrator/states.js";
import type { ActiveWorker } from "../orchestrator/workers.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

/** A task of a run, as the view shows it. */
export interface RunTask {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly reason?: string;
}

const MARKS: Record<TaskState, { mark: string; color: string }> = {
  pending: { mark: "○", color: theme.muted },
  ready: { mark: "◌", color: theme.accent },
  running: { mark: "●", color: theme.accent },
  blocked: { mark: "⊘", color: theme.warning },
  review: { mark: "?", color: theme.warning },
  completed: { mark: "✓", color: theme.success },
  failed: { mark: "✗", color: theme.error },
  cancelled: { mark: "–", color: theme.muted },
};

/** A run in progress: each task with its state, and who works on it now. */
export function RunView({
  runId,
  tasks,
  workers,
  state,
}: {
  readonly runId: string;
  readonly tasks: readonly RunTask[];
  readonly workers: readonly ActiveWorker[];
  readonly state: string;
}): ReactNode {
  const done = tasks.filter((t) => t.state === "completed").length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      marginTop={1}
    >
      <Text>
        <Text bold color={theme.brand}>
          Run
        </Text>
        <Text dimColor>
          {" "}
          {runId} · {state} · {String(done)}/{String(tasks.length)} done · {String(workers.length)}{" "}
          working
        </Text>
      </Text>
      {tasks.map((task) => {
        const worker = workers.find((w) => w.task === task.id);
        const look = MARKS[task.state];
        return (
          <Box key={task.id} flexDirection="column">
            <Text wrap="truncate-end">
              {task.state === "running" ? <Spinner /> : <Text color={look.color}>{look.mark}</Text>}
              <Text> {task.id.padEnd(20)}</Text>
              <Text dimColor> {task.state.padEnd(10)}</Text>
              {worker ? (
                <Text color={theme.accent}>
                  {" "}
                  {worker.model}
                  {worker.effort ? ` · ${worker.effort}` : ""}
                </Text>
              ) : (
                <Text dimColor> {task.title}</Text>
              )}
            </Text>
            {task.reason !== undefined &&
              (task.state === "review" || task.state === "failed" || task.state === "blocked") && (
                <Text color={theme.warning} wrap="truncate-end">
                  {"    "}
                  {task.reason.split("\n", 1)[0]}
                </Text>
              )}
          </Box>
        );
      })}
      <Text dimColor>esc pauses the run · ctrl+c cancels it</Text>
    </Box>
  );
}
