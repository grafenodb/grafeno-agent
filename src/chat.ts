import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Agent, AgentError } from "./agent/agent.js";
import type { Approver } from "./agent/tools.js";
import { ModelError, type ModelEvent, type UsageWindow } from "./model/index.js";

export interface ChatOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** Makes the agent, given how to ask the user before a writing tool runs. */
  readonly makeAgent: (approve: Approver) => Agent;
  /** Warn when a plan window is at least this full. Default: 0.8. */
  readonly warnAt?: number;
  /** Sent as a last turn when the user leaves after talking, such as asking to save a checkpoint. */
  readonly endOfSession?: string;
}

const HELP = `Commands:
  /usage  what this session spent, and the plan's usage windows
  /help   this help
  /exit   leave (or Ctrl+D)
Ctrl+C cancels the answer being written.`;

/**
 * The command-line conversation: reads the user's lines, runs a turn for
 * each, and shows the answer, the tools used and the plan's usage as they
 * come. A writing tool asks here before it runs.
 */
export async function runChat(options: ChatOptions): Promise<void> {
  const { output } = options;
  const warnAt = options.warnAt ?? 0.8;
  const lines = createInterface({
    input: options.input,
    output,
    terminal: "isTTY" in options.input && options.input.isTTY === true,
  });
  const reader = lines[Symbol.asyncIterator]();
  const write = (text: string) => output.write(text);
  let current: AbortController | undefined;
  const warned = new Set<string>();

  lines.on("SIGINT", () => {
    if (current) {
      current.abort();
    } else {
      lines.close();
    }
  });

  async function readLine(prompt: string): Promise<string | undefined> {
    write(prompt);
    const next = await reader.next();
    return next.done === true ? undefined : next.value;
  }

  const approve: Approver = async (call) => {
    write(`\n  ? ${call.name} wants to run with ${JSON.stringify(call.input)}\n`);
    const answer = await readLine("    Allow it? [y/N] ");
    return /^(y|yes|s|si|sí)$/i.test(answer?.trim() ?? "");
  };

  const agent = options.makeAgent(approve);

  /** Runs one turn and shows it; true when the chat cannot go on. */
  async function runTurn(message: string): Promise<boolean> {
    current = new AbortController();
    let answered = false;
    const onEvent = (event: ModelEvent) => {
      switch (event.type) {
        case "text":
          if (!answered) write("\n");
          answered = true;
          write(event.text);
          break;
        case "tool_call":
          write(`\n  → ${event.call.name} ${JSON.stringify(event.call.input)}\n`);
          break;
        case "tool_result":
          write(
            `  ← ${event.outcome.isError === true ? "error: " : ""}${firstLine(event.outcome.content)}\n`,
          );
          break;
        case "usage_windows":
          for (const window of event.windows) {
            if (window.utilization !== undefined && window.utilization >= warnAt) {
              if (!warned.has(window.name)) {
                warned.add(window.name);
                write(
                  `\n  ! The plan's ${window.name} window is ${percent(window.utilization)} used.\n`,
                );
              }
            }
          }
          break;
        case "done":
          break;
      }
    };

    try {
      const turn = await agent.turn(message, { signal: current.signal, onEvent });
      if (turn.restarted) {
        write(
          "\n  (The conversation with the model had ended and was started again: it does not remember this session's earlier turns.)\n",
        );
      }
      if (turn.result.stopReason === "max_steps") {
        write("\n  (Stopped at the step limit for one turn.)\n");
      } else if (turn.result.stopReason === "max_tokens") {
        write("\n  (The answer reached its length limit.)\n");
      } else if (turn.result.stopReason === "refusal") {
        write("\n  (The model declined to answer.)\n");
      }
      write("\n");
    } catch (error) {
      write(`\n  ${describeError(error)}\n`);
      if (error instanceof ModelError && error.kind === "setup") return true;
    } finally {
      current = undefined;
    }
    return false;
  }

  write(`Grafeno Agent. Type /help for commands.\n`);

  let stopped = false;
  try {
    for (;;) {
      const line = await readLine("\n> ");
      if (line === undefined) break;
      const text = line.trim();
      if (text === "") continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        write(`${HELP}\n`);
        continue;
      }
      if (text === "/usage") {
        write(`${describeUsage(agent)}\n`);
        continue;
      }

      if (await runTurn(text)) {
        stopped = true;
        break;
      }
    }
    if (!stopped && options.endOfSession !== undefined && agent.turns > 0) {
      write("\n  Saving where this session stands...\n");
      await runTurn(options.endOfSession);
    }
  } finally {
    lines.close();
    await agent.close();
  }
}

function describeError(error: unknown): string {
  if (error instanceof ModelError) {
    switch (error.kind) {
      case "usage_limit":
        return `Stopped: ${error.message}`;
      case "cancelled":
        return "Cancelled.";
      case "timeout":
        return `Stopped: ${error.message}.`;
      default:
        return `The model failed (${error.kind}): ${error.message}`;
    }
  }
  if (error instanceof AgentError) return error.message;
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

function describeUsage(agent: Agent): string {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = agent.usage;
  const lines = [
    `This session: ${String(agent.turns)} turns; ${String(inputTokens)} input and ${String(outputTokens)} output tokens (${String(cacheReadTokens)} read from cache, ${String(cacheWriteTokens)} written to it).`,
  ];
  if (agent.windows.length === 0) lines.push("The plan's usage windows are not known yet.");
  for (const window of agent.windows) lines.push(describeWindow(window));
  return lines.join("\n");
}

function describeWindow(window: UsageWindow): string {
  const used = window.utilization === undefined ? "?" : percent(window.utilization);
  const resets = window.resetsAt ? `; resets ${window.resetsAt.toISOString()}` : "";
  return `Plan window ${window.name}: ${used} used${window.allowed ? "" : " (limit reached)"}${resets}`;
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
