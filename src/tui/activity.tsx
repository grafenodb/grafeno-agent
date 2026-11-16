import { Box, Text } from "ink";
import type { ReactNode } from "react";
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
