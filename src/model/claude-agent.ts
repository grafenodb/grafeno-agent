import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "./types.js";

/**
 * The part of the Claude Agent SDK this adapter uses: `query()`, whose
 * messages it reads. Declared here (not imported) so that the SDK stays
 * optional: it is installed on demand, and tests give a stand-in.
 */
export interface AgentSdk {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<SdkMessage>;
}

/** The SDK's messages, as far as this adapter reads them. */
export type SdkMessage =
  | {
      type: "system";
      subtype?: string;
      apiKeySource?: string;
      model?: string;
      session_id?: string;
    }
  | {
      type: "stream_event";
      event?: { type?: string; delta?: { type?: string; text?: string } };
    }
  | {
      type: "assistant";
      error?: string;
      message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
    }
  | {
      type: "result";
      subtype: string;
      session_id?: string;
      result?: string;
      stop_reason?: string | null;
      num_turns?: number;
      total_cost_usd?: number;
      errors?: string[];
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  | { type: string };

export interface ClaudeAgentOptions {
  /** A model alias (`sonnet`, `opus`, `haiku`) or a full model id; undefined: the SDK's default. */
  readonly model?: string;
  readonly effort?: string;
  /** The user's Anthropic API key, asked for each turn; never kept by the model. */
  readonly key: () => Promise<string | undefined>;
  /** Loads the SDK (installed on demand); throws when it is not there. */
  readonly sdk: () => Promise<AgentSdk>;
  /** A spending limit per turn, in US dollars (the SDK's own estimate). */
  readonly maxBudgetUsd?: number;
  /** The environment the SDK's process starts from (only safe variables are kept). */
  readonly env?: Record<string, string | undefined>;
}

/** Environment variables a process needs to run, and nothing else of the user's. */
const SAFE_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The SDK process's environment: the bare minimum to run, the API key, and
 * a configuration folder of its own (so it never finds a subscription's
 * sign-in, settings or sessions of the user). Nothing else: not the
 * agent's keys, not other providers' keys, not a Claude sign-in token.
 */
export function agentEnv(
  base: Record<string, string | undefined>,
  key: string,
  configDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SAFE_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.ANTHROPIC_API_KEY = key;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * Claude through the official Claude Agent SDK, with the user's API key
 * (billed per token): the SDK runs the agent loop; the agent's own tools
 * reach it over a local MCP server, each call decided by the agent's
 * permissions. Built-in tools are off. Each turn checks that the SDK
 * authenticated with the API key, and stops otherwise.
 */
export class ClaudeAgentModel implements Model {
  readonly name = "claude-api";

  constructor(private readonly options: ClaudeAgentOptions) {}

  async open(options: ConversationOptions): Promise<Conversation> {
    const conversation = new ClaudeAgentConversation(this.options, options);
    await conversation.start();
    return conversation;
  }
}

interface Turn {
  readonly channel: Channel<ModelEvent>;
  readonly signal: AbortSignal;
  steps: number;
  stepLimitHit: boolean;
}

class ClaudeAgentConversation implements Conversation {
  #tools: McpToolServer | undefined;
  #dir: string | undefined;
  #session: string | undefined;
  #turn: Turn | undefined;
  #calls = 0;
  #closed = false;

  constructor(
    private readonly options: ClaudeAgentOptions,
    private readonly conversation: ConversationOptions,
  ) {}

  async start(): Promise<void> {
    this.#tools = await serveTools(this.conversation.tools.tools, (name, input) =>
      this.#runTool(name, input),
    );
    // Its own folder: the SDK's configuration and sessions, and its working folder.
    this.#dir = await mkdtemp(join(tmpdir(), "grafeno-agent-claude-api-"));
  }

  send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    if (this.#closed) throw new ModelError("lost", "The conversation is closed");
    if (this.#turn) throw new ModelError("failed", "A turn is already running");
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortReason(signal);
    const turn: Turn = {
      channel: new Channel<ModelEvent>(),
      signal,
      steps: 1,
      stepLimitHit: false,
    };
    this.#turn = turn;
    void this.#run(turn, message).then(
      () => {
        turn.channel.end();
      },
      (error: unknown) => {
        turn.channel.fail(
          signal.aborted
            ? abortReason(signal)
            : error instanceof ModelError
              ? error
              : new ModelError("failed", error instanceof Error ? error.message : String(error), {
                  cause: error,
                }),
        );
      },
    );
    const done = () => {
      if (this.#turn === turn) this.#turn = undefined;
    };
    const channel = turn.channel;
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = channel[Symbol.asyncIterator]();
        return {
          next: async () => {
            try {
              const next = await iterator.next();
              if (next.done) done();
              return next;
            } catch (error) {
              done();
              throw error;
            }
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tools?.close();
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async #run(turn: Turn, message: string): Promise<void> {
    const key = await this.options.key();
    if (!key) {
      throw new ModelError(
        "setup",
        "claude-api has no Anthropic API key: grafeno-agent login claude-api, or ANTHROPIC_API_KEY.",
      );
    }
    let sdk: AgentSdk;
    try {
      sdk = await this.options.sdk();
    } catch (error) {
      throw new ModelError(
        "setup",
        "The Claude Agent SDK is not installed: grafeno-agent providers install claude-api.",
        { cause: error },
      );
    }
    const tools = this.#tools;
    const dir = this.#dir;
    if (!tools || !dir) throw new ModelError("lost", "The conversation is not started");
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      // The turn ends at once, whenever the SDK stops.
      turn.channel.fail(abortReason(turn.signal));
    };
    turn.signal.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    const options: Record<string, unknown> = {
      systemPrompt: this.conversation.system,
      // No built-in tools: only the agent's own, through its MCP server.
      tools: [],
      mcpServers: { agent: { type: "http", url: tools.url, headers: tools.headers } },
      allowedTools: ["mcp__agent"],
      // Anything else is refused: the agent's permissions decide its own tools.
      canUseTool: () =>
        Promise.resolve({ behavior: "deny", message: "Only the agent's own tools may be used." }),
      permissionMode: "default",
      settingSources: [],
      includePartialMessages: true,
      abortController: controller,
      cwd: dir,
      env: agentEnv(this.options.env ?? process.env, key, dir),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(this.conversation.maxSteps ? { maxTurns: this.conversation.maxSteps } : {}),
      ...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
      ...(this.#session ? { resume: this.#session } : {}),
      stderr: (data: string) => {
        stderr = (stderr + data).slice(-2000);
      },
    };
    let text = "";
    try {
      for await (const msg of sdk.query({ prompt: message, options })) {
        if (turn.signal.aborted) throw abortReason(turn.signal);
        const done = this.#onMessage(turn, msg, text, key);
        if (typeof done === "string") text = done;
        else if (done) {
          turn.channel.push(done);
          return;
        }
      }
    } catch (error) {
      if (turn.signal.aborted) throw abortReason(turn.signal);
      if (error instanceof ModelError) throw error;
      const detail = scrub(
        `${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr.trim()}` : ""}`,
        key,
      );
      throw new ModelError("unavailable", `The Claude Agent SDK failed: ${detail}`, {
        cause: error,
      });
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
    }
    throw new ModelError("failed", "The Claude Agent SDK ended the turn without a result");
  }

  /** One message: an event pushed, the text so far, or the turn's end. */
  #onMessage(
    turn: Turn,
    msg: SdkMessage,
    text: string,
    key: string,
  ): ModelEvent | string | undefined {
    switch (msg.type) {
      case "system": {
        const init = msg as Extract<SdkMessage, { type: "system" }>;
        if (init.subtype !== "init") return undefined;
        // The safeguard: this provider uses the API key, never a subscription's sign-in.
        if (init.apiKeySource !== "ANTHROPIC_API_KEY") {
          throw new ModelError(
            "setup",
            `claude-api signs in only with an API key, and the SDK used "${init.apiKeySource ?? "unknown"}": stopped.`,
          );
        }
        if (init.session_id) this.#session = init.session_id;
        if (init.model) turn.channel.push({ type: "model_info", model: init.model });
        return undefined;
      }
      case "stream_event": {
        const event = (msg as Extract<SdkMessage, { type: "stream_event" }>).event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const piece = event.delta.text ?? "";
          if (piece !== "") turn.channel.push({ type: "text", text: piece });
          return text + piece;
        }
        return undefined;
      }
      case "assistant": {
        const assistant = msg as Extract<SdkMessage, { type: "assistant" }>;
        if (assistant.error) throw apiError(assistant.error);
        const used =
          (assistant.message?.usage?.input_tokens ?? 0) +
          (assistant.message?.usage?.cache_read_input_tokens ?? 0);
        if (used > 0) turn.channel.push({ type: "context", used });
        return undefined;
      }
      case "result": {
        const result = msg as Extract<SdkMessage, { type: "result" }>;
        if (result.session_id) this.#session = result.session_id;
        const usage = usageOf(result);
        switch (result.subtype) {
          case "success":
            return {
              type: "done",
              result: {
                text: text || (result.result ?? ""),
                stopReason: turn.stepLimitHit ? "max_steps" : stopReason(result.stop_reason),
                usage,
                steps: Math.max(turn.steps, result.num_turns ?? 1),
              },
            };
          case "error_max_turns":
            return {
              type: "done",
              result: {
                text,
                stopReason: "max_steps",
                usage,
                steps: result.num_turns ?? turn.steps,
              },
            };
          case "error_max_budget_usd":
            throw new ModelError(
              "failed",
              `claude-api stopped at its spending limit for a turn (CLAUDE_API_MAX_BUDGET_USD); it cost $${(result.total_cost_usd ?? 0).toFixed(4)}.`,
            );
          default:
            throw new ModelError(
              "failed",
              scrub(`claude-api: ${(result.errors ?? []).join("; ") || result.subtype}`, key),
            );
        }
      }
      default:
        return undefined;
    }
  }

  async #runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const turn = this.#turn;
    if (!turn) return { content: "No turn is running.", isError: true };
    if (turn.steps >= (this.conversation.maxSteps ?? Infinity)) {
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
}

/** The SDK's usage and cost, as the agent counts them. */
function usageOf(result: Extract<SdkMessage, { type: "result" }>): Usage {
  return {
    inputTokens: result.usage?.input_tokens ?? 0,
    outputTokens: result.usage?.output_tokens ?? 0,
    cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result.usage?.cache_creation_input_tokens ?? 0,
    ...(typeof result.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
  };
}

function stopReason(reason: string | null | undefined): StopReason {
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "end_turn";
}

/** The SDK's API errors, as the agent's kinds. */
export function apiError(error: string): ModelError {
  switch (error) {
    case "authentication_failed":
    case "billing_error":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "cloud_credential_error":
      return new ModelError(
        "setup",
        `claude-api: ${error.replace(/_/g, " ")} (check the API key and its billing)`,
      );
    case "rate_limit":
      return new ModelError("usage_limit", "claude-api: the API's rate limit is reached", {
        resetsAt: new Date(Date.now() + 60_000),
      });
    case "overloaded":
    case "server_error":
      return new ModelError("unavailable", `claude-api: ${error.replace(/_/g, " ")}`);
    default:
      return new ModelError("failed", `claude-api: ${error.replace(/_/g, " ")}`);
  }
}

/** A message without the key in it, whatever happened. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[key]") : text;
}
