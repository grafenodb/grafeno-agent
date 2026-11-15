import { ModelError } from "./errors.js";
import { abortReason } from "./turn.js";
import type {
  Conversation,
  ConversationOptions,
  Model,
  ModelEvent,
  SendOptions,
  StopReason,
  ToolHost,
  Usage,
} from "./types.js";

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModelOptions {
  /** A model id such as `gemini-flash-latest`. */
  readonly model: string;
  /** `low` or `high`: Gemini's thinking level, when the model takes one. */
  readonly effort?: string;
  /**
   * The user's key, asked for each request from where it is kept; never
   * stored by the model, never in a message, an error or a log.
   */
  readonly key: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly api?: string;
  readonly now?: () => Date;
}

/** One part of a Gemini message, kept as Gemini sent it (thought signatures included). */
type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
};

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
}

/**
 * Gemini through Google AI Studio's API (`generateContent`), with the
 * agent's own tools as function declarations: the model asks, the agent's
 * `ToolHost` decides and runs each call, and the answer goes back as a
 * function response, until the model answers.
 */
export class GeminiModel implements Model {
  readonly name = "gemini";

  constructor(private readonly options: GeminiModelOptions) {}

  open(options: ConversationOptions): Promise<Conversation> {
    return Promise.resolve(new GeminiConversation(this.options, options));
  }
}

class GeminiConversation implements Conversation {
  readonly #history: Content[] = [];
  #busy = false;

  constructor(
    private readonly model: GeminiModelOptions,
    private readonly options: ConversationOptions,
  ) {}

  async *send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    if (this.#busy) throw new ModelError("failed", "One turn at a time");
    this.#busy = true;
    const signal = options.signal ?? new AbortController().signal;
    const before = this.#history.length;
    try {
      this.#history.push({ role: "user", parts: [{ text: message }] });
      let usage: Usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let text = "";
      const maxSteps = this.options.maxSteps ?? 40;
      for (let step = 1; ; step++) {
        const answer = await this.#generate(signal);
        const meta = answer.usageMetadata ?? {};
        usage = {
          inputTokens:
            usage.inputTokens + (meta.promptTokenCount ?? 0) - (meta.cachedContentTokenCount ?? 0),
          outputTokens:
            usage.outputTokens + (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
          cacheReadTokens: usage.cacheReadTokens + (meta.cachedContentTokenCount ?? 0),
          cacheWriteTokens: 0,
        };
        if (answer.modelVersion) yield { type: "model_info", model: answer.modelVersion };
        if (meta.promptTokenCount) yield { type: "context", used: meta.promptTokenCount };
        if (answer.promptFeedback?.blockReason) {
          yield done(text, "refusal", usage, step);
          return;
        }
        const candidate = answer.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        // Kept whole: Gemini needs its own parts (and thought signatures) back.
        this.#history.push({ role: "model", parts });
        for (const part of parts) {
          if (typeof part.text === "string" && part.thought !== true && part.text !== "") {
            text += part.text;
            yield { type: "text", text: part.text };
          }
        }
        const calls = parts.filter((p) => p.functionCall?.name);
        if (calls.length === 0) {
          yield done(text, stopReason(candidate?.finishReason), usage, step);
          return;
        }
        if (step >= maxSteps) {
          yield done(text, "max_steps", usage, step);
          return;
        }
        const responses: Part[] = [];
        for (const [index, part] of calls.entries()) {
          const fc = part.functionCall ?? {};
          const call = {
            id: fc.id ?? `call-${String(step)}-${String(index)}`,
            name: fc.name ?? "",
            input: fc.args ?? {},
          };
          yield { type: "tool_call", call };
          if (signal.aborted) throw abortReason(signal);
          const outcome = await this.options.tools.call(call, signal);
          yield { type: "tool_result", callId: call.id, outcome };
          responses.push({
            functionResponse: {
              ...(fc.id ? { id: fc.id } : {}),
              name: call.name,
              response: outcome.isError ? { error: outcome.content } : { content: outcome.content },
            },
          });
        }
        this.#history.push({ role: "user", parts: responses });
      }
    } catch (error) {
      // A turn that did not end leaves the conversation as it was before it.
      this.#history.length = before;
      if (signal.aborted) throw abortReason(signal);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  close(): Promise<void> {
    this.#history.length = 0;
    return Promise.resolve();
  }

  async #generate(signal: AbortSignal): Promise<GenerateResponse> {
    const key = await this.model.key();
    if (!key) {
      throw new ModelError("setup", "No Gemini API key: grafeno-agent login gemini sets one up.");
    }
    const effort = this.model.effort;
    const body = {
      systemInstruction: { parts: [{ text: this.options.system }] },
      contents: this.#history,
      ...(this.options.tools.tools.length > 0
        ? { tools: [{ functionDeclarations: declarations(this.options.tools) }] }
        : {}),
      ...(effort ? { generationConfig: { thinkingConfig: { thinkingLevel: effort } } } : {}),
    };
    let response: Response;
    try {
      response = await (this.model.fetch ?? fetch)(
        `${this.model.api ?? GEMINI_API}/models/${encodeURIComponent(this.model.model)}:generateContent`,
        {
          method: "POST",
          // The key in a header, never in the URL.
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new ModelError("unavailable", "Gemini could not be reached", { cause: error });
    }
    if (response.ok) return (await response.json()) as GenerateResponse;
    throw await apiError(response, this.model.now?.() ?? new Date());
  }
}

/** The turn's last event. */
function done(text: string, stopReason: StopReason, usage: Usage, steps: number): ModelEvent {
  return { type: "done", result: { text, stopReason, usage, steps } };
}

/** The agent's tools as Gemini function declarations (their JSON Schemas as they are). */
function declarations(host: ToolHost) {
  return host.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));
}

function stopReason(finish: string | undefined): StopReason {
  switch (finish) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** A failed request as the agent's kinds of errors; the key never appears in one. */
export async function apiError(response: Response, now: Date): Promise<ModelError> {
  let data: {
    error?: { message?: string; status?: string; details?: { retryDelay?: string }[] };
  } = {};
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // Not JSON: the status says enough.
  }
  const message = data.error?.message ?? `HTTP ${String(response.status)}`;
  if (response.status === 429) {
    const delay = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const seconds = delay ? Number.parseFloat(delay) : 60;
    return new ModelError("usage_limit", `Gemini's quota is used up for now: ${message}`, {
      resetsAt: new Date(now.getTime() + (Number.isFinite(seconds) ? seconds : 60) * 1000),
    });
  }
  if (response.status === 401 || response.status === 403) {
    return new ModelError("setup", `Gemini refused the key: ${message}`);
  }
  if (response.status >= 500) return new ModelError("unavailable", `Gemini: ${message}`);
  return new ModelError("failed", `Gemini: ${message}`);
}
