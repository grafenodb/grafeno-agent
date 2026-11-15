import { ModelError } from "./errors.js";
import { abortReason } from "./turn.js";
import type {
  Conversation,
  ConversationOptions,
  Model,
  ModelEvent,
  SendOptions,
  StopReason,
  Usage,
} from "./types.js";

export interface ChatCompletionsOptions {
  /** The adapter's name, such as `openrouter`. */
  readonly name: string;
  /** The API's base, such as `https://openrouter.ai/api/v1`. */
  readonly api: string;
  readonly model: string;
  /** A reasoning effort (`low`, `medium`, `high`), for models that take one. */
  readonly effort?: string;
  /**
   * The user's key, asked for each request from where it is kept; never
   * stored by the model, never in a message, an error or a log.
   */
  readonly key: () => Promise<string | undefined>;
  /** Headers that are not secret, such as the app's title. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What to say when there is no key. */
  readonly noKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** A message of an OpenAI-style chat. */
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallWire[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: ToolCallWire[] };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** Some APIs (OpenRouter) report an error with HTTP 200. */
  error?: { code?: number; message?: string };
}

/**
 * A model behind an OpenAI-compatible chat completions API (OpenRouter and
 * others): the agent's tools as functions, each call decided and run by the
 * agent's own tool host, its answer sent back as a `tool` message, until
 * the model answers.
 */
export class ChatCompletionsModel implements Model {
  readonly name: string;

  constructor(private readonly options: ChatCompletionsOptions) {
    this.name = options.name;
  }

  open(options: ConversationOptions): Promise<Conversation> {
    return Promise.resolve(new ChatConversation(this.options, options));
  }
}

class ChatConversation implements Conversation {
  readonly #messages: Message[];
  #busy = false;

  constructor(
    private readonly model: ChatCompletionsOptions,
    private readonly options: ConversationOptions,
  ) {
    this.#messages = [{ role: "system", content: options.system }];
  }

  async *send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    if (this.#busy) throw new ModelError("failed", "One turn at a time");
    this.#busy = true;
    const signal = options.signal ?? new AbortController().signal;
    const before = this.#messages.length;
    try {
      this.#messages.push({ role: "user", content: message });
      let usage: Usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let text = "";
      const maxSteps = this.options.maxSteps ?? 40;
      for (let step = 1; ; step++) {
        const answer = await this.#complete(signal);
        const cached = answer.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          inputTokens: usage.inputTokens + (answer.usage?.prompt_tokens ?? 0) - cached,
          outputTokens: usage.outputTokens + (answer.usage?.completion_tokens ?? 0),
          cacheReadTokens: usage.cacheReadTokens + cached,
          cacheWriteTokens: 0,
        };
        if (answer.model) yield { type: "model_info", model: answer.model };
        if (answer.usage?.prompt_tokens)
          yield { type: "context", used: answer.usage.prompt_tokens };
        const choice = answer.choices?.[0];
        const content = choice?.message?.content ?? "";
        const calls = choice?.message?.tool_calls ?? [];
        this.#messages.push({
          role: "assistant",
          content: content === "" ? null : content,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
        if (content !== "") {
          text += content;
          yield { type: "text", text: content };
        }
        if (calls.length === 0) {
          yield done(text, stopReason(choice?.finish_reason), usage, step);
          return;
        }
        if (step >= maxSteps) {
          yield done(text, "max_steps", usage, step);
          return;
        }
        for (const wire of calls) {
          const call = { id: wire.id, name: wire.function.name, input: parseArguments(wire) };
          yield { type: "tool_call", call };
          if (signal.aborted) throw abortReason(signal);
          const outcome = await this.options.tools.call(call, signal);
          yield { type: "tool_result", callId: call.id, outcome };
          this.#messages.push({
            role: "tool",
            tool_call_id: wire.id,
            content: outcome.isError ? `Error: ${outcome.content}` : outcome.content,
          });
        }
      }
    } catch (error) {
      // A turn that did not end leaves the conversation as it was before it.
      this.#messages.length = before;
      if (signal.aborted) throw abortReason(signal);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  close(): Promise<void> {
    this.#messages.length = 1;
    return Promise.resolve();
  }

  async #complete(signal: AbortSignal): Promise<ChatResponse> {
    const key = await this.model.key();
    if (!key) throw new ModelError("setup", this.model.noKey);
    const tools = this.options.tools.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    const body = {
      model: this.model.model,
      messages: this.#messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(this.model.effort ? { reasoning: { effort: this.model.effort } } : {}),
    };
    let response: Response;
    try {
      response = await (this.model.fetch ?? fetch)(`${this.model.api}/chat/completions`, {
        method: "POST",
        headers: {
          ...this.model.headers,
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new ModelError("unavailable", `${this.model.name} could not be reached`, {
        cause: error,
      });
    }
    const now = this.model.now?.() ?? new Date();
    if (!response.ok) throw await chatError(this.model.name, response, now);
    const answer = (await response.json()) as ChatResponse;
    // An error may come with HTTP 200 once the model started.
    if (answer.error) {
      throw new ModelError(
        "failed",
        `${this.model.name}: ${answer.error.message ?? "the model failed"}`,
      );
    }
    return answer;
  }
}

function parseArguments(wire: ToolCallWire): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(wire.function.arguments || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function done(text: string, stopReason: StopReason, usage: Usage, steps: number): ModelEvent {
  return { type: "done", result: { text, stopReason, usage, steps } };
}

function stopReason(finish: string | undefined): StopReason {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** A failed request as the agent's kinds of errors; the key never appears in one. */
export async function chatError(name: string, response: Response, now: Date): Promise<ModelError> {
  let data: { error?: { message?: string } } = {};
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // Not JSON: the status says enough.
  }
  const message = data.error?.message ?? `HTTP ${String(response.status)}`;
  switch (response.status) {
    case 401:
      return new ModelError("setup", `${name} refused the key: ${message}`);
    case 402:
      return new ModelError("setup", `${name}: no credits left for this model (${message})`);
    case 403:
      return new ModelError("failed", `${name} blocked the request: ${message}`);
    case 429: {
      const after = Number(response.headers.get("retry-after"));
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const resetsAt =
        Number.isFinite(after) && after > 0
          ? new Date(now.getTime() + after * 1000)
          : Number.isFinite(reset) && reset > now.getTime()
            ? new Date(reset)
            : new Date(now.getTime() + 60_000);
      return new ModelError("usage_limit", `${name}'s rate limit is reached: ${message}`, {
        resetsAt,
      });
    }
    default:
      return response.status === 408 || response.status >= 500
        ? new ModelError("unavailable", `${name}: ${message}`)
        : new ModelError("failed", `${name}: ${message}`);
  }
}
