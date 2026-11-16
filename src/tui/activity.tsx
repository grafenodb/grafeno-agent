import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { Clickable } from "./clicks.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

/** A tool call as a person reads it: what it does, to what, and what came of it. */
export interface Action {
  /** A short verb: Read, Edit, Run… */
  readonly verb: string;
  /** What it acts on: a file, a command, a URL, a search. */
  readonly target: string;
  /** What came of it, in a few words: "120 lines", "exit 0", "3 matches". */
  readonly summary?: string;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const oneLine = (text: string, max = 90) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Memory tools, by the words they are read with. */
const MEMORY: Readonly<Record<string, string>> = {
  recall: "Recall",
  context: "Recall",
  remember: "Remember",
  relate: "Relate",
  forget: "Forget",
  revise: "Revise",
  checkpoint: "Checkpoint",
  feedback: "Feedback",
  palace_anchor: "Anchor",
  palace_enter: "Enter room",
  palace_walk: "Walk",
};

/** How a tool call reads: its verb and its target, from its name and arguments. */
export function describeAction(name: string, input: Record<string, unknown>): Action {
  const path = str(input.path);
  switch (name) {
    case "read_file": {
      const from = typeof input.offset === "number" ? input.offset : undefined;
      const lines = typeof input.limit === "number" ? input.limit : undefined;
      const range =
        from !== undefined || lines !== undefined
          ? ` (lines ${String(from ?? 1)}${lines !== undefined ? `–${String((from ?? 1) + lines - 1)}` : "+"})`
          : "";
      return { verb: "Read", target: `${path}${range}` };
    }
    case "list_files":
      return {
        verb: "List",
        target: `${path || "."}${str(input.pattern) ? ` ${str(input.pattern)}` : ""}`,
      };
    case "search_files":
      return {
        verb: "Search",
        target: `“${oneLine(str(input.pattern), 50)}”${str(input.glob) ? ` in ${str(input.glob)}` : path ? ` in ${path}` : ""}`,
      };
    case "file_info":
      return { verb: "Look at", target: path };
    case "write_file":
      return {
        verb: "Write",
        target: `${path} (${String(str(input.content).split(/\r?\n/).length)} lines)`,
      };
    case "edit_file":
      return { verb: "Edit", target: path };
    case "multi_edit":
      return {
        verb: "Edit",
        target: `${path} (${String(Array.isArray(input.edits) ? input.edits.length : 0)} changes)`,
      };
    case "move_file":
      return { verb: "Move", target: `${str(input.from)} → ${str(input.to)}` };
    case "delete_file":
      return { verb: "Delete", target: path };
    case "run_command":
      return { verb: "Run", target: oneLine(str(input.command)) };
    case "start_process":
      return { verb: "Start", target: oneLine(str(input.command)) };
    case "process_output":
    case "stop_process":
      return { verb: name === "stop_process" ? "Stop" : "Output", target: str(input.id) };
    case "list_processes":
      return { verb: "Processes", target: "" };
    case "local_http":
    case "web_fetch":
      return {
        verb: name === "web_fetch" ? "Fetch" : str(input.method) || "GET",
        target: oneLine(str(input.url)),
      };
    case "read_document":
      return {
        verb: "Document",
        target: `${path}${str(input.pages) ? ` (${str(input.pages)})` : ""}`,
      };
    case "web_search":
      return { verb: "Web search", target: `“${oneLine(str(input.query), 60)}”` };
    case "environment_info":
      return { verb: "Environment", target: "system, shell, programs" };
    case "current_time":
      return { verb: "Time", target: "" };
    case "delegate":
      return { verb: "Sub-agents", target: oneLine(str(input.request), 70) };
    case "skill":
      return { verb: "Skill", target: str(input.name) };
    case "report_progress":
      return { verb: "Report", target: oneLine(str(input.summary), 70) };
    case "request_work":
      return { verb: "Ask", target: oneLine(str(input.what), 70) };
    default: {
      const memory = MEMORY[name];
      if (memory) {
        const what = str(input.query) || str(input.text) || str(input.name) || str(input.task);
        return { verb: memory, target: oneLine(what, 70) };
      }
      const main = ["path", "command", "url", "query", "name", "title", "id"]
        .map((key) => str(input[key]))
        .find((value) => value !== "");
      return { verb: name.replace(/_/g, " "), target: oneLine(main ?? "", 70) };
    }
  }
}

/** What came of a call, in a few words, from what it returned. */
export function summarizeOutcome(name: string, content: string, failed: boolean): string {
  const first = content.split("\n", 1)[0] ?? "";
  if (failed) return oneLine(first.replace(/^Not allowed: /, "not allowed: "), 100);
  switch (name) {
    case "read_file": {
      const lines = /lines (\d+)-(\d+) of (\d+)/.exec(first);
      return lines ? `${lines[3] ?? "?"} lines` : "";
    }
    case "list_files": {
      const files = content.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("(")).length;
      return content.startsWith("No files") ? "none" : `${String(files)} files`;
    }
    case "search_files": {
      if (content.startsWith("No matches")) return "no matches";
      const matches = content.split("\n").filter((l) => /^\S+:\d+:/.test(l)).length;
      return `${String(matches)} matches`;
    }
    case "run_command":
    case "start_process": {
      const code = /Exit code (\d+)|Stopped after (\d+) ms|Process (\w+) \((\w+)\)/.exec(first);
      if (code?.[1] !== undefined) return code[1] === "0" ? "ok" : `exit ${code[1]}`;
      if (code?.[2] !== undefined) return "timed out";
      if (code?.[3] !== undefined) return `${code[3]} ${code[4] ?? ""}`.trim();
      return "";
    }
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "move_file":
    case "delete_file":
      return oneLine(first.replace(/\.$/, ""), 60);
    default:
      return "";
  }
}

/** One action on its own line: its state, its verb, its target and what came of it. */
export function ActionLine({
  action,
  state,
}: {
  readonly action: Action;
  readonly state: "running" | "done" | "failed";
}): ReactNode {
  return (
    <Box paddingLeft={2}>
      <Box width={2} flexShrink={0}>
        {state === "running" ? (
          <Spinner />
        ) : (
          <Text color={state === "failed" ? theme.error : theme.success}>
            {state === "failed" ? "✗" : "✓"}
          </Text>
        )}
      </Box>
      <Box width={11} flexShrink={0}>
        <Text color={state === "failed" ? theme.error : theme.accent} bold>
          {action.verb}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        <Text>{action.target}</Text>
        {action.summary ? (
          <Text {...(state === "failed" ? { color: theme.error } : { dimColor: true })}>
            {"  "}· {action.summary}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}

/** A finished action and what it showed: kept so a folded group can be unfolded. */
export interface ActionRecord {
  readonly action: Action;
  readonly failed: boolean;
  /** What it did, in a few lines: the change, the command's output, the error. */
  readonly output?: string;
}

/** Lines of output kept for each action, unfolded. */
export const OUTPUT_LINES = 12;

const clip = (text: string, lines = OUTPUT_LINES) => {
  const all = text.replace(/\r/g, "").split("\n");
  const kept = all
    .slice(0, lines)
    .map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
  return all.length > lines ? [...kept, `… ${String(all.length - lines)} more lines`] : kept;
};

/** What an action did, shown when its group is unfolded: a change as - and + lines, else what it returned. */
export function actionOutput(
  name: string,
  input: Record<string, unknown>,
  content: string,
  failed: boolean,
): string {
  if (failed) return clip(content, 4).join("\n");
  const diff = (before: string, after: string) => [
    ...before.split(/\r?\n/).map((l) => `- ${l}`),
    ...after.split(/\r?\n/).map((l) => `+ ${l}`),
  ];
  switch (name) {
    case "edit_file":
      return clip(diff(str(input.old_text), str(input.new_text)).join("\n")).join("\n");
    case "multi_edit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      return clip(edits.flatMap((e) => diff(str(e.old_text), str(e.new_text))).join("\n")).join(
        "\n",
      );
    }
    case "write_file":
      return clip(str(input.content)).join("\n");
    case "read_file":
    case "read_document":
    case "web_fetch":
      // What it read is long and the model's; its first lines say enough.
      return clip(content, 4).join("\n");
    default:
      return clip(content).join("\n");
  }
}

/** How many of each kind, as a person says it: "Read 3 files, edited 2 files, ran a command". */
export function groupSummary(records: readonly ActionRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.action.verb, (counts.get(r.action.verb) ?? 0) + 1);
  const n = (count: number, one: string, many = `${one}s`) =>
    count === 1 ? `a ${one}` : `${String(count)} ${many}`;
  const files = (count: number) => (count === 1 ? "a file" : `${String(count)} files`);
  const said = [...counts].map(([verb, count]) => {
    switch (verb) {
      case "Read":
        return `read ${files(count)}`;
      case "Edit":
        return `edited ${files(count)}`;
      case "Write":
        return `wrote ${files(count)}`;
      case "Delete":
        return `deleted ${files(count)}`;
      case "Move":
        return `moved ${files(count)}`;
      case "Look at":
        return `looked at ${files(count)}`;
      case "Document":
        return `read ${n(count, "document")}`;
      case "Run":
        return `ran ${n(count, "command")}`;
      case "Start":
        return `started ${n(count, "process", "processes")}`;
      case "Search":
        return `searched ${count === 1 ? "once" : `${String(count)} times`}`;
      case "List":
        return `listed ${n(count, "folder")}`;
      case "Fetch":
        return `fetched ${n(count, "page")}`;
      case "Web search":
        return `searched the web ${count === 1 ? "once" : `${String(count)} times`}`;
      default:
        return count === 1 ? verb.toLowerCase() : `${verb.toLowerCase()} ×${String(count)}`;
    }
  });
  const text = said.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Finished actions in a row, folded into one line ("Read 3 files, edited
 * a file") that unfolds, with a click or ctrl+o, into each action and what
 * it did.
 */
export function ActionGroup({
  records,
  open,
  onToggle,
}: {
  readonly records: readonly ActionRecord[];
  readonly open: boolean;
  readonly onToggle?: () => void;
}): ReactNode {
  const failed = records.filter((r) => r.failed).length;
  const only = records.length === 1 ? records[0] : undefined;
  return (
    <Box flexDirection="column">
      <Clickable paddingLeft={2} onClick={onToggle}>
        <Box width={2} flexShrink={0}>
          <Text color={failed > 0 ? theme.error : theme.success}>{failed > 0 ? "✗" : "✓"}</Text>
        </Box>
        <Text wrap="truncate-end">
          {only ? (
            <>
              <Text color={only.failed ? theme.error : theme.accent} bold>
                {only.action.verb}
              </Text>
              <Text> {only.action.target}</Text>
              {only.action.summary ? (
                <Text {...(only.failed ? { color: theme.error } : { dimColor: true })}>
                  {"  "}· {only.action.summary}
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <Text bold>{groupSummary(records)}</Text>
              {failed > 0 && <Text color={theme.error}> · {String(failed)} failed</Text>}
            </>
          )}
          <Text dimColor> {open ? "▾" : "▸"}</Text>
        </Text>
      </Clickable>
      {open &&
        records.map((record, index) => (
          <Box key={index} flexDirection="column">
            {!only && (
              <ActionLine action={record.action} state={record.failed ? "failed" : "done"} />
            )}
            {record.output !== undefined && record.output.trim() !== "" && (
              <Box paddingLeft={6} flexDirection="column">
                {record.output.split("\n").map((line, at) => (
                  <Text
                    key={at}
                    wrap="truncate-end"
                    {...(record.failed
                      ? { color: theme.error }
                      : line.startsWith("+ ")
                        ? { color: theme.success }
                        : line.startsWith("- ")
                          ? { color: theme.error }
                          : { dimColor: true })}
                  >
                    {line === "" ? " " : line}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        ))}
    </Box>
  );
}
