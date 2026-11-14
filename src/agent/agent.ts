import {
  ModelError,
  NO_USAGE,
  type Conversation,
  type Model,
  type ModelEvent,
  type ToolHost,
  type TurnResult,
  type Usage,
  type UsageWindow,
} from "../model/index.js";

export interface AgentLimits {
  /** Model requests one turn may take (each round of tool calls is one more). Default: 20. */
  readonly maxSteps?: number;
  /**
   * Tokens (input and output) the whole session may spend; once spent, no
   * new turn starts. Default: no limit beyond the plan's own.
   */
  readonly maxSessionTokens?: number;
}

export interface AgentOptions {
  readonly model: Model;
  readonly system: string;
  readonly tools: ToolHost;
  readonly limits?: AgentLimits;
}

export interface TurnOptions {
  readonly signal?: AbortSignal;
  /** Told of each event as it comes: text, tool calls and results, usage windows. */
  readonly onEvent?: (event: ModelEvent) => void;
}

export interface AgentTurn {
  readonly result: TurnResult;
  /** The conversation with the model had ended and was started again: it forgot this session. */
  readonly restarted: boolean;
}

export class AgentError extends Error {
  constructor(
    readonly kind: "empty" | "busy" | "budget",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

const DEFAULT_MAX_STEPS = 20;

/**
 * The agent's loop. Each turn sends the user's words to the model, which
 * calls the agent's tools (through its `ToolHost`) until it answers. The
 * agent keeps the limits, counts what the session spent, and starts the
 * conversation again when the model lost it.
 */
export class Agent {
  #conversation: Conversation | undefined;
  #busy = false;
  #spent: Usage = NO_USAGE;
  #windows: readonly UsageWindow[] = [];
  #turns = 0;

  constructor(private readonly options: AgentOptions) {}

  /** What the session has spent so far. */
  get usage(): Usage {
    return this.#spent;
  }

  /** The plan's usage windows, as the model last reported them. */
  get windows(): readonly UsageWindow[] {
    return this.#windows;
  }

  get turns(): number {
    return this.#turns;
  }

  async turn(input: string, options: TurnOptions = {}): Promise<AgentTurn> {
    const message = input.trim();
    if (message === "") throw new AgentError("empty", "Nothing to send.");
    if (this.#busy) throw new AgentError("busy", "A turn is already running.");
    const budget = this.options.limits?.maxSessionTokens;
    if (budget !== undefined && tokens(this.#spent) >= budget) {
      throw new AgentError(
        "budget",
        `This session has spent its ${String(budget)} tokens. Start a new session to go on.`,
      );
    }

    this.#busy = true;
    try {
      let restarted = false;
      for (;;) {
        const started = this.#conversation === undefined;
        const conversation = await this.#open();
        const progress = { seen: false };
        try {
          const result = await this.#run(conversation, message, options, () => {
            progress.seen = true;
          });
          this.#turns++;
          return { result, restarted };
        } catch (error) {
          // The model lost the conversation before this turn began (its
          // process ended after an earlier turn): start again, once.
          if (error instanceof ModelError && error.kind === "lost") {
            await this.#drop();
            if (!progress.seen && !started && !restarted) {
              restarted = true;
              continue;
            }
          }
          throw error;
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    await this.#drop();
  }

  async #open(): Promise<Conversation> {
    this.#conversation ??= await this.options.model.open({
      system: this.options.system,
      tools: this.options.tools,
      maxSteps: this.options.limits?.maxSteps ?? DEFAULT_MAX_STEPS,
    });
    return this.#conversation;
  }

  async #drop(): Promise<void> {
    const conversation = this.#conversation;
    this.#conversation = undefined;
    await conversation?.close();
  }

  async #run(
    conversation: Conversation,
    message: string,
    options: TurnOptions,
    onSeen: () => void,
  ): Promise<TurnResult> {
    let result: TurnResult | undefined;
    const stream = conversation.send(message, options.signal ? { signal: options.signal } : {});
    for await (const event of stream) {
      if (event.type === "usage_windows") this.#windows = event.windows;
      else onSeen();
      if (event.type === "done") {
        result = event.result;
        this.#spent = add(this.#spent, event.result.usage);
      }
      options.onEvent?.(event);
    }
    if (!result) throw new ModelError("failed", "The turn ended without an answer");
    return result;
  }
}

function tokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
