import { Box, Text } from "ink";
import { useState, type ReactNode } from "react";
import type { OperationalStore } from "../../orchestrator/store.js";
import { runFields, runRows, taskFields, taskRows } from "../adapters/runs.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";
import { Inspector } from "../ui/inspector.js";
import { Table } from "../ui/table.js";

const RUN_COLUMNS = [
  { key: "request", title: "Request", width: 44 },
  { key: "state", title: "State" },
  { key: "tasks", title: "Tasks" },
  { key: "updated", title: "Updated" },
];
const TASK_COLUMNS = [
  { key: "task", title: "Task", width: 36 },
  { key: "state", title: "State" },
  { key: "tries", title: "Tries", align: "right" as const },
  { key: "model", title: "Model" },
];

/**
 * A project's runs: each with its state and tasks; Enter opens one (what
 * it recorded, and its tasks), Enter on a task shows its attempts; o opens
 * the run as before (its report when it ended, or it goes on). Esc goes
 * back a step, and closes from the list.
 */
export function RunsView(props: {
  readonly store: OperationalStore;
  /** The run's report when it ended, or it goes on (what /runs did). */
  readonly onOpen: (runId: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [run, setRun] = useState<string | undefined>(undefined);
  const [task, setTask] = useState<string | undefined>(undefined);
  const record = run ? props.store.run(run) : undefined;
  useKeys((input, key) => {
    if (task) return;
    if (key.escape) {
      if (run) setRun(undefined);
      else props.onClose();
    } else if (input === "o" && run) props.onOpen(run);
  });
  const rows = runRows(props.store);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      {!record ? (
        <>
          <Text>
            <Text bold color={theme.focus}>
              Runs
            </Text>
            <Text dimColor> · {String(rows.length)} in this project</Text>
          </Text>
          <Table
            columns={RUN_COLUMNS}
            rows={rows}
            sortable
            isActive={run === undefined}
            onOpen={setRun}
          />
          <Text dimColor>↑↓ choose · enter its tasks · ←→ r sort · esc close</Text>
        </>
      ) : (
        <>
          <Text>
            <Text bold color={theme.focus}>
              Run · {record.id}
            </Text>
          </Text>
          {runFields(record, props.store).map((field) => (
            <Text key={field.label} wrap="truncate-end">
              <Text dimColor>{field.label.padEnd(12)}</Text>
              <Text {...(field.tone ? { color: theme[field.tone] } : {})}>{field.value}</Text>
            </Text>
          ))}
          <Box marginTop={1}>
            <Table
              columns={TASK_COLUMNS}
              rows={taskRows(props.store, record.id)}
              height={8}
              isActive={task === undefined}
              onOpen={setTask}
            />
          </Box>
          <Text dimColor>
            enter a task&apos;s attempts · o{" "}
            {record.state === "completed" || record.state === "cancelled"
              ? "its report"
              : "go on with it"}{" "}
            · esc back
          </Text>
        </>
      )}
      {record && task && (
        <Inspector
          title={`Task · ${task}`}
          fields={taskFields(props.store, record.id, task)}
          onClose={() => {
            setTask(undefined);
          }}
        />
      )}
    </Box>
  );
}
