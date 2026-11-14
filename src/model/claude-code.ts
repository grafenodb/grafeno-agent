import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Channel } from "./channel.js";
import { ModelError } from "./errors.js";
import { serveTools, type McpToolServer } from "./mcp-host.js";
import { abortReason } from "./turn.js";
import type {
  Conversation,
  ConversationOptions,
  Model,
  ModelEvent,
  SendOptions,
  StopReason,
  ToolOutcome,
  Usage,
  UsageWindow,
} from "./types.js";

/** The MCP server name Claude Code knows the agent's tools by. */
const SERVER = "agent";
const TOOL_PREFIX = `mcp__${SERVER}__`;

export interface ClaudeCodeOptions {
  /** The Claude Code program. Default: `claude` from the PATH. */
  readonly command?: string;
  /** A model alias or name for Claude Code (`haiku`, `sonnet`, `opus`…). Default: its own. */
  readonly model?: string;
  /** For tests: how to start the program. */
  readonly spawn?: typeof nodeSpawn;
}

/**
 * Claude through the user's own Claude Code: it starts the official,
 * unmodified `claude` program, which uses the login the user made in Claude
 * Code and spends that plan's usage. This adapter never reads or handles
 * those credentials.
 *
 * Claude is used only as the brain: Claude Code's own tools are turned off,
 * and the only tools it has are the agent's, served over MCP from this
 * process, so every call goes through the agent's `ToolHost`.
 */
export class ClaudeCodeModel implements Model {
  readonly name = "claude-code";

  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  async open(conversationOptions: ConversationOptions): Promise<Conversation> {
    const conversation = new ClaudeCodeConversation(this.options, conversationOptions);
    await conversation.start();
    return conversation;
  }
}

interface Turn {
  readonly channel: Channel<ModelEvent>;
  readonly signal: AbortSignal;
  text: string;
  /** Model requests so far: one, plus one after each assistant message that called tools. */
  steps: number;
  stepLimitHit: boolean;
  limit: { resetsAt?: Date } | undefined;
}

class ClaudeCodeConversation implements Conversation {
  #process: ChildProcess | undefined;
  #tools: McpToolServer | undefined;
  #dir: string | undefined;
  #turn: Turn | undefined;
  #dead: ModelError | undefined;
  #stderr = "";
  #calls = 0;

  constructor(
    private readonly options: ClaudeCodeOptions,
    private readonly conversation: ConversationOptions,
  ) {}

  async start(): Promise<void> {
    this.#tools = await serveTools(this.conversation.tools.tools, (name, input) =>
      this.#runTool(name, input),
    );
    // A private folder: the working directory (so no project's settings
    // apply) and the files that carry the system prompt and the MCP secret.
    this.#dir = await mkdtemp(join(tmpdir(), "grafeno-agent-"));
    const mcpConfig = join(this.#dir, "mcp.json");
    const systemPrompt = join(this.#dir, "system.md");
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          [SERVER]: { type: "http", url: this.#tools.url, headers: this.#tools.headers },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(systemPrompt, this.conversation.system, { mode: 0o600 });

    const args = [
      "--print",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      "--tools=",
      `--mcp-config=${mcpConfig}`,
      "--strict-mcp-config",
      `--allowedTools=mcp__${SERVER}`,
      "--permission-prompts=none",
      `--system-prompt-file=${systemPrompt}`,
      "--setting-sources=",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
    ];
    if (this.options.model !== undefined) args.push(`--model=${this.options.model}`);

    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(this.options.command ?? "claude", args, {
      cwd: this.#dir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.#die(
        error.code === "ENOENT"
          ? new ModelError(
              "setup",
              "Claude Code was not found. Install it and sign in once (run `claude`, then `/login`).",
              { cause: error },
            )
          : new ModelError("lost", `Claude Code could not start: ${error.message}`, {
              cause: error,
            }),
      );
    });
    child.on("exit", (code, signal) => {
      const detail = this.#stderr.trim();
      this.#die(
        new ModelError(
          "lost",
          `Claude Code ended (${signal ?? `code ${String(code)}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.on("error", () => {
      // The exit handler reports it.
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.#onLine(line);
    });
  }

  send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    if (this.#dead) throw this.#dead;
    if (this.#turn) throw new ModelError("failed", "A turn is already running");
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortReason(signal);

    const turn: Turn = {
      channel: new Channel<ModelEvent>(),
      signal,
      text: "",
      steps: 1,
      stepLimitHit: false,
      limit: undefined,
    };
    this.#turn = turn;
    // Claude Code cannot drop one turn and keep the conversation: cancelling
    // stops the program, and the conversation with it.
    const onAbort = () => {
      this.#endTurn(turn, abortReason(signal));
      this.#dead ??= new ModelError("lost", "The conversation was stopped by a cancelled turn");
      this.#process?.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const line = JSON.stringify({ type: "user", message: { role: "user", content: message } });
    this.#process?.stdin?.write(`${line}\n`);

    const channel = turn.channel;
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = channel[Symbol.asyncIterator]();
        return {
          next: async () => {
            try {
              return await iterator.next();
            } finally {
              if (channel.ended) signal.removeEventListener("abort", onAbort);
            }
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.#dead ??= new ModelError("lost", "The conversation is closed");
    const child = this.#process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.stdin?.end();
      const timer = setTimeout(() => child.kill(), 3_000);
      await exited;
      clearTimeout(timer);
    }
    await this.#tools?.close();
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
  }

  async #runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const turn = this.#turn;
    if (!turn) return { content: "No turn is running.", isError: true };
    const maxSteps = this.conversation.maxSteps ?? Infinity;
    if (turn.steps >= maxSteps) {
      turn.stepLimitHit = true;
      return {
        content: "This turn has reached its step limit. Answer now with what you have.",
        isError: true,
      };
    }
    const call = { id: `call-${String(++this.#calls)}`, name, input };
    turn.channel.push({ type: "tool_call", call });
    let outcome: ToolOutcome;
    try {
      outcome = await this.conversation.tools.call(call, turn.signal);
    } catch (error) {
      outcome = {
        content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    turn.channel.push({ type: "tool_result", callId: call.id, outcome });
    return outcome;
  }

  #onLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return; // Not ours to read.
    }
    const turn = this.#turn;
    if (!turn) return;

    switch (event.type) {
      case "assistant": {
        const blocks = event.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
            turn.text += block.text;
            turn.channel.push({ type: "text", text: block.text });
          }
        }
        if (blocks.some((b) => b.type === "tool_use" && b.name?.startsWith(TOOL_PREFIX))) {
          turn.steps++;
        }
        break;
      }
      case "rate_limit_event": {
        const info = event.rate_limit_info;
        if (!info) break;
        const windows = readWindows(info);
        if (windows.length > 0) turn.channel.push({ type: "usage_windows", windows });
        if (
          info.status !== undefined &&
          info.status !== "allowed" &&
          info.status !== "allowed_warning"
        ) {
          turn.limit = info.resetsAt === undefined ? {} : { resetsAt: fromEpoch(info.resetsAt) };
        }
        break;
      }
      case "result": {
        this.#finish(turn, event);
        break;
      }
      default:
        break;
    }
  }

  #finish(turn: Turn, result: StreamEvent): void {
    const failed =
      result.is_error === true ||
      (result.subtype !== "success" && result.subtype !== "error_max_turns");
    if (failed) {
      this.#endTurn(turn, resultError(result, turn));
      return;
    }
    let stopReason: StopReason = mapStopReason(result.stop_reason);
    if (result.subtype === "error_max_turns" || turn.stepLimitHit) stopReason = "max_steps";
    turn.channel.push({
      type: "done",
      result: {
        text: turn.text !== "" ? turn.text : (result.result ?? ""),
        stopReason,
        usage: readUsage(result.usage),
        steps: Math.max(turn.steps, result.num_turns ?? 1),
      },
    });
    this.#endTurn(turn);
  }

  #endTurn(turn: Turn, error?: ModelError): void {
    if (this.#turn === turn) this.#turn = undefined;
    if (error) turn.channel.fail(error);
    else turn.channel.end();
  }

  #die(error: ModelError): void {
    this.#dead ??= error;
    const turn = this.#turn;
    if (turn) this.#endTurn(turn, error);
  }
}

/** The parts of Claude Code's stream-json events this adapter reads. */
interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  num_turns?: number;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: { content?: { type?: string; text?: string; name?: string }[] };
  rate_limit_info?: RateLimitInfo;
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
}

function fromEpoch(seconds: number): Date {
  return new Date(seconds * 1000);
}

function readWindows(info: RateLimitInfo): UsageWindow[] {
  const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, window]) => ({
    name,
    allowed: window.status === undefined || window.status.startsWith("allowed"),
    ...(window.utilization === undefined ? {} : { utilization: window.utilization }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: fromEpoch(window.resetsAt) }),
  }));
  if (windows.length === 0 && info.rateLimitType !== undefined) {
    windows.push({
      name: info.rateLimitType,
      allowed: info.status === undefined || info.status.startsWith("allowed"),
      ...(info.resetsAt === undefined ? {} : { resetsAt: fromEpoch(info.resetsAt) }),
    });
  }
  return windows;
}

function readUsage(usage: StreamEvent["usage"]): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function resultError(result: StreamEvent, turn: Turn): ModelError {
  const text = (result.result ?? "").trim();
  const detail = text !== "" ? text : `Claude Code reported ${result.subtype ?? "an error"}`;
  if (turn.limit || /usage limit|limit reached|out of usage/i.test(text)) {
    return new ModelError(
      "usage_limit",
      `The Claude plan's usage limit is reached${turn.limit?.resetsAt ? `; it resets at ${turn.limit.resetsAt.toISOString()}` : ""}. ${detail}`,
      turn.limit?.resetsAt ? { resetsAt: turn.limit.resetsAt } : undefined,
    );
  }
  if (/not logged in|please run \/login|invalid api key|authenticat/i.test(text)) {
    return new ModelError(
      "setup",
      `Claude Code is not signed in. Run \`claude\` and sign in with \`/login\`. (${detail})`,
    );
  }
  const status = result.api_error_status ?? undefined;
  if (status !== undefined && (status === 429 || status === 408 || status >= 500)) {
    return new ModelError("unavailable", `Claude is unavailable (${String(status)}): ${detail}`);
  }
  if (/overloaded|timed? ?out|ECONNRESET|network/i.test(text)) {
    return new ModelError("unavailable", `Claude is unavailable: ${detail}`);
  }
  return new ModelError("failed", detail);
}
