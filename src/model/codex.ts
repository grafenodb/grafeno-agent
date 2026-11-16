import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { childEnv } from "./env.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
  ToolOutcome,
  Usage,
} from "./types.js";

/** The MCP server name Codex knows the agent's tools by. */
const SERVER = "agent";
/** The environment variable that carries the MCP secret to Codex (never the command line). */
const TOKEN_VARIABLE = "GRAFENO_AGENT_MCP_TOKEN";

/**
 * How to start Codex without a shell: on Windows, npm installs `codex` as a
 * `.cmd` shim that only a shell runs, and through a shell the arguments (the
 * instructions, with quotes and line breaks) would be mangled. So there the
 * package's own launcher (`bin/codex.js`) is run with Node; elsewhere, the
 * `codex` on the PATH.
 */
export function codexCommand(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): { command: string; prefix: string[] } {
  if (process.platform === "win32") {
    const roots = [
      env.APPDATA ? join(env.APPDATA, "npm", "node_modules") : undefined,
      env.npm_config_prefix ? join(env.npm_config_prefix, "node_modules") : undefined,
    ];
    for (const root of roots) {
      if (root === undefined) continue;
      const launcher = join(root, "@openai", "codex", "bin", "codex.js");
      if (exists(launcher)) return { command: process.execPath, prefix: [launcher] };
    }
  }
  return { command: "codex", prefix: [] };
}

export interface CodexOptions {
  /** The Codex program, and arguments before Codex's own. Default: `codexCommand()`. */
  readonly command?: string;
  readonly commandPrefix?: readonly string[];
  /** A model slug for Codex (`gpt-6-luna`…). Default: its own. */
  readonly model?: string;
  /** The reasoning effort (`low` … `max`). Default: the model's own. */
  readonly effort?: string;
  /** For tests: how to start the program. */
  readonly spawn?: typeof nodeSpawn;
}

/**
 * The model through the user's own Codex CLI, signed in with their ChatGPT
 * plan: each turn runs `codex exec --json` (the first) or `codex exec
 * resume` (the next ones), so what it asks spends that plan, and this
 * adapter never reads Codex's credentials.
 *
 * Codex is used as the brain only, as Claude is. Its shell, image viewer
 * and web search are turned off. Its file patches cannot be, so it runs
 * with a read-only sandbox in a private, empty folder, where any patch is
 * rejected. The only tools it can use are the agent's, served over MCP
 * from this process, so every change goes through the agent's
 * permissions. The user's own Codex settings (their MCP servers, plugins)
 * are ignored.
 */
export class CodexModel implements Model {
  readonly name = "codex";

  constructor(private readonly options: CodexOptions = {}) {}

  async open(conversationOptions: ConversationOptions): Promise<Conversation> {
    const conversation = new CodexConversation(this.options, conversationOptions);
    await conversation.start();
    return conversation;
  }
}

interface Turn {
  readonly channel: Channel<ModelEvent>;
  readonly signal: AbortSignal;
  text: string;
  steps: number;
  stepLimitHit: boolean;
  usage: Usage;
  failure: string | undefined;
  done: boolean;
}

class CodexConversation implements Conversation {
  #tools: McpToolServer | undefined;
  #dir: string | undefined;
  #thread: string | undefined;
  #turn: Turn | undefined;
  #process: ChildProcess | undefined;
  #closed = false;
  #calls = 0;

  constructor(
    private readonly options: CodexOptions,
    private readonly conversation: ConversationOptions,
  ) {}

  async start(): Promise<void> {
    this.#tools = await serveTools(this.conversation.tools.tools, (name, input) =>
      this.#runTool(name, input),
    );
    // A private, empty folder: nothing of the user's for Codex to read, and
    // the read-only sandbox rejects any patch there.
    this.#dir = await mkdtemp(join(tmpdir(), "grafeno-agent-codex-"));
  }

  #args(): string[] {
    const tools = this.#tools;
    if (!tools) throw new ModelError("lost", "The conversation is not started");
    const config = (key: string, value: string) => ["-c", `${key}=${value}`];
    const args = [
      "exec",
      ...(this.#thread === undefined ? [] : ["resume"]),
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      ...config("sandbox_mode", '"read-only"'),
      ...config("approval_policy", '"never"'),
      ...config("features.shell_tool", "false"),
      ...config("features.view_image", "false"),
      ...config("web_search", '"disabled"'),
      ...config(`mcp_servers.${SERVER}.url`, JSON.stringify(tools.url)),
      ...config(`mcp_servers.${SERVER}.bearer_token_env_var`, JSON.stringify(TOKEN_VARIABLE)),
      // Codex does not ask about the agent's tools: the agent's own permissions
      // decide each call (ToolRegistry, and the run's policy). Asked, with
      // approvals off, Codex refused every tool that writes.
      ...config(`mcp_servers.${SERVER}.default_tools_approval_mode`, '"approve"'),
      ...config(
        "developer_instructions",
        JSON.stringify(
          `${toolsPreface(this.conversation.tools.tools.map((t) => t.name))}\n\n${this.conversation.system}`,
        ),
      ),
    ];
    if (this.options.model !== undefined) args.push("-m", this.options.model);
    if (this.options.effort !== undefined) {
      args.push(...config("model_reasoning_effort", JSON.stringify(this.options.effort)));
    }
    if (this.#thread !== undefined) args.push(this.#thread);
    args.push("-"); // The message comes on stdin.
    return args;
  }

  send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    if (this.#closed) throw new ModelError("lost", "The conversation is closed");
    if (this.#turn) throw new ModelError("failed", "A turn is already running");
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortReason(signal);
    const tools = this.#tools;
    if (!tools) throw new ModelError("lost", "The conversation is not started");

    const turn: Turn = {
      channel: new Channel<ModelEvent>(),
      signal,
      text: "",
      steps: 1,
      stepLimitHit: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      failure: undefined,
      done: false,
    };
    this.#turn = turn;

    const spawn = this.options.spawn ?? nodeSpawn;
    const found = this.options.command === undefined ? codexCommand() : undefined;
    const command = this.options.command ?? found?.command ?? "codex";
    const prefix = this.options.commandPrefix ?? found?.prefix ?? [];
    const child = spawn(command, [...prefix, ...this.#args()], {
      cwd: this.#dir,
      // Without CODEX_API_KEY or OPENAI_API_KEY: Codex signs in with ChatGPT, as its login says.
      env: childEnv(process.env, {
        [TOKEN_VARIABLE]: (tools.headers.Authorization ?? "").replace(/^Bearer /, ""),
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdin.on("error", () => {
      // The exit handler reports it.
    });
    child.stdin.end(message);

    const onAbort = () => {
      // Codex keeps the conversation: the next message resumes it. The turn
      // ends as cancelled first, so the process closing after is not read
      // as a failure.
      this.#endTurn(turn, abortReason(signal));
      child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    createInterface({ input: child.stdout }).on("line", (line) => {
      this.#onLine(turn, line);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.#endTurn(
        turn,
        error.code === "ENOENT"
          ? new ModelError(
              "setup",
              "Codex was not found. Install it (npm install -g @openai/codex) and sign in once (codex login).",
              { cause: error },
            )
          : new ModelError("unavailable", `Codex could not start: ${error.message}`, {
              cause: error,
            }),
      );
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (this.#turn !== turn) return;
      if (signal.aborted) {
        this.#endTurn(turn, abortReason(signal));
        return;
      }
      if (turn.done) {
        turn.channel.push({
          type: "done",
          result: {
            text: turn.text,
            stopReason: turn.stepLimitHit ? "max_steps" : "end_turn",
            usage: turn.usage,
            steps: turn.steps,
          },
        });
        this.#endTurn(turn);
        return;
      }
      const detail = [turn.failure, stderr.trim()].filter(Boolean).join(" — ");
      this.#endTurn(turn, codexError(detail, code));
    });

    return turn.channel;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#process?.kill();
    await this.#tools?.close();
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
  }

  async #runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const turn = this.#turn;
    if (!turn) return { content: "No turn is running.", isError: true };
    const maxSteps = this.conversation.maxSteps ?? Infinity;
    if (turn.steps > maxSteps) {
      turn.stepLimitHit = true;
      return {
        content: "This turn has reached its step limit. Answer now with what you have.",
        isError: true,
      };
    }
    turn.steps++;
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

  #onLine(turn: Turn, line: string): void {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return; // Not ours to read.
    }
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.#thread = event.thread_id;
        if (this.options.model !== undefined) {
          turn.channel.push({ type: "model_info", model: this.options.model });
        }
        break;
      case "item.completed":
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          const text = turn.text === "" ? event.item.text : `\n\n${event.item.text}`;
          turn.text += text;
          turn.channel.push({ type: "text", text });
        }
        break;
      case "turn.completed": {
        const usage = event.usage ?? {};
        const input = usage.input_tokens ?? 0;
        const cached = usage.cached_input_tokens ?? 0;
        turn.usage = {
          inputTokens: Math.max(0, input - cached),
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: usage.cache_write_input_tokens ?? 0,
        };
        turn.channel.push({ type: "context", used: input });
        turn.done = true;
        break;
      }
      case "turn.failed":
      case "error":
        turn.failure = event.error?.message ?? event.message ?? "Codex reported an error";
        break;
      default:
        break;
    }
  }

  #endTurn(turn: Turn, error?: ModelError): void {
    if (this.#turn === turn) this.#turn = undefined;
    if (error) turn.channel.fail(error);
    else turn.channel.end();
  }
}

/** The parts of Codex's `--json` events this adapter reads. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Said before the agent's own instructions, every turn. Found by the first
 * mixed real run: told nothing, Codex tries its own patch tool, which the
 * read-only sandbox rejects, and says it cannot write, without trying the
 * agent's tools.
 */
export function toolsPreface(tools: readonly string[]): string {
  return [
    "How you work here: you have no shell, and you cannot edit files yourself. The folder you start in is not the project, and it is read-only: do not use apply_patch or any built-in editing, and do not say the workspace is read-only.",
    tools.length > 0
      ? `Everything you do in the project goes through the tools of the MCP server named "agent": ${tools.join(", ")}. To read, list, search, write or edit files, or to run commands, call those tools; paths are relative to the project.`
      : "You have no tools in this conversation: answer in words.",
  ].join("\n");
}

/** What a failed turn means, from what Codex said. */
export function codexError(detail: string, code: number | null): ModelError {
  const text = detail.trim() === "" ? `Codex ended with code ${String(code)}` : detail.trim();
  if (/usage limit|rate limit|hit your (usage )?limit|quota|purchase more credits/i.test(text)) {
    return new ModelError("usage_limit", `The ChatGPT plan's Codex limit is reached. ${text}`);
  }
  if (
    /not (logged|signed) in|codex login|unauthori[sz]ed|401|expired.*(token|session)|re-?authenticate/i.test(
      text,
    )
  ) {
    return new ModelError("setup", `Codex is not signed in. Run \`codex login\`. (${text})`);
  }
  if (/session.*not found|no (such )?(session|thread)|unknown (session|thread)/i.test(text)) {
    return new ModelError("lost", `Codex lost the conversation: ${text}`);
  }
  if (
    /overloaded|timed? ?out|timeout|ECONNRESET|network|5\d\d|stream (disconnected|error)|server error/i.test(
      text,
    )
  ) {
    return new ModelError("unavailable", `Codex is unavailable: ${text}`);
  }
  return new ModelError("failed", text);
}
