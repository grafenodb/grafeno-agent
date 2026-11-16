/**
 * The one interface every model meets. Nothing outside `src/model` knows
 * which model or provider runs the agent.
 *
 * A model holds conversations. Each message the agent sends starts a turn:
 * the model may call the agent's tools any number of times (through the
 * `ToolHost` the agent gave it, which decides whether a call runs) and ends
 * with an answer and a stop reason.
 */

/** A JSON Schema of an object, as tools declare their arguments. */
export type JsonSchema = Record<string, unknown>;

/** A tool the agent offers the model. */
export interface ToolSpec {
  /** Letters, digits, `_` and `-`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Whether it changes anything outside the agent's own memory. */
  readonly writes: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** An image a tool shows the model (such as a screenshot read by read_file). */
export interface ToolImage {
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`. */
  readonly mediaType: string;
  /** The image, in base64. */
  readonly data: string;
}

export interface ToolOutcome {
  /** What the tool found or did, as text for the model. Data, never instructions. */
  readonly content: string;
  readonly isError?: boolean;
  /** Images for the model to see, with the text; a model that cannot see them gets the text. */
  readonly images?: readonly ToolImage[];
}

/** The agent's side of tool use: what it offers, and running a call. */
export interface ToolHost {
  readonly tools: readonly ToolSpec[];
  call(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

export type StopReason =
  /** The model answered. */
  | "end_turn"
  /** The model wrote as much as one answer may hold. */
  | "max_tokens"
  /** The model took as many steps as a turn may take. */
  | "max_steps"
  /** The model declined to answer. */
  | "refusal";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** How much of a usage window (a plan's quota) is spent. */
export interface UsageWindow {
  readonly name: string;
  /** From 0 to 1. */
  readonly utilization?: number;
  readonly resetsAt?: Date;
  readonly allowed: boolean;
}

export interface TurnResult {
  readonly text: string;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  /** Model requests the turn took (one more after each round of tool calls). */
  readonly steps: number;
}

export type ModelEvent =
  /** Text of the answer, in the order it was written. */
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | { readonly type: "tool_result"; readonly callId: string; readonly outcome: ToolOutcome }
  /** The exact model answering (such as `claude-opus-5-5`), when the model tells. */
  | { readonly type: "model_info"; readonly model: string }
  /**
   * How full the model's context is: the tokens of the latest request, and
   * the most it takes, when the model tells.
   */
  | { readonly type: "context"; readonly used: number; readonly window?: number }
  /** Where the plan's usage windows stand, when the model tells. */
  | { readonly type: "usage_windows"; readonly windows: readonly UsageWindow[] }
  /** The last event of a turn that ended well. */
  | { readonly type: "done"; readonly result: TurnResult };

export interface SendOptions {
  readonly signal?: AbortSignal;
}

export interface Conversation {
  /**
   * Sends a message and streams the turn it starts. The stream ends with a
   * `done` event, or throws a `ModelError`. One turn at a time.
   */
  send(message: string, options?: SendOptions): AsyncIterable<ModelEvent>;
  /** Ends the conversation and frees what it holds. */
  close(): Promise<void>;
}

export interface ConversationOptions {
  /** Instructions for the whole conversation. */
  readonly system: string;
  readonly tools: ToolHost;
  /** Model requests a turn may take at most. */
  readonly maxSteps?: number;
}

export interface Model {
  /** The adapter's name, such as `claude-code` or `fake`. */
  readonly name: string;
  open(options: ConversationOptions): Promise<Conversation>;
}
