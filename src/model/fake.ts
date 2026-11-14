import { ModelError, type ModelErrorKind } from "./errors.js";
import { sleep } from "./resilient.js";
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

/** What a scripted step can see: the message, and what the tools answered so far. */
export interface FakeContext {
  readonly system: string;
  readonly message: string;
  /** Messages sent earlier in the conversation, oldest first. */
  readonly history: readonly string[];
  /** Outcomes of this turn's tool calls so far, in order. */
  readonly results: readonly ToolOutcome[];
  /** Tries of this turn so far (0 on the first). */
  readonly attempt: number;
}

export type FakeStep =
  /** Write text. */
  | { readonly say: string | ((context: FakeContext) => string) }
  /** Call one of the agent's tools. */
  | {
      readonly call: string;
      readonly input?:
        Record<string, unknown> | ((context: FakeContext) => Record<string, unknown>);
    }
  /** Fail the turn, on the first `attempts` tries only (default: always). */
  | { readonly fail: ModelErrorKind; readonly message?: string; readonly attempts?: number }
  /** Wait, as a slow model does; honours cancellation. */
  | { readonly wait: number }
  /** End the turn with this stop reason instead of `end_turn`. */
  | { readonly stop: StopReason };

/** The steps of one turn, fixed or chosen from what was asked. */
export type FakeTurn = readonly FakeStep[] | ((context: FakeContext) => readonly FakeStep[]);

export interface FakeModelOptions {
  /** One entry per turn, in order; the last repeats when the script runs out. */
  readonly turns: readonly FakeTurn[];
}

/**
 * A scripted model, to test everything else without calling a real one. It
 * runs tool calls through the agent's `ToolHost`, as a real model would.
 */
export class FakeModel implements Model {
  readonly name = "fake";
  /** Every conversation opened, with what it was sent. */
  readonly conversations: { system: string; messages: string[] }[] = [];

  constructor(private readonly options: FakeModelOptions) {
    if (options.turns.length === 0) throw new Error("A fake model needs at least one turn");
  }

  open(conversationOptions: ConversationOptions): Promise<Conversation> {
    const record = { system: conversationOptions.system, messages: [] as string[] };
    this.conversations.push(record);
    const turns = this.options.turns;
    let turnIndex = 0;
    let attempt = 0;
    let busy = false;
    let closed = false;
    let callCount = 0;

    async function* send(
      message: string,
      sendOptions: SendOptions = {},
    ): AsyncGenerator<ModelEvent> {
      if (closed) throw new ModelError("lost", "The conversation is closed");
      if (busy) throw new ModelError("failed", "A turn is already running");
      busy = true;
      const signal = sendOptions.signal ?? new AbortController().signal;
      const history = [...record.messages];
      try {
        const turn = turns[Math.min(turnIndex, turns.length - 1)] as FakeTurn;
        const results: ToolOutcome[] = [];
        const context = (): FakeContext => ({
          system: record.system,
          message,
          history,
          results: [...results],
          attempt,
        });
        const steps = typeof turn === "function" ? turn(context()) : turn;
        const maxSteps = conversationOptions.maxSteps ?? Infinity;
        let text = "";
        let modelSteps = 1;
        let afterCall = false;
        let stopReason: StopReason = "end_turn";

        for (const step of steps) {
          if (signal.aborted) throw abortReason(signal);
          if (afterCall && !("call" in step)) {
            modelSteps++;
            afterCall = false;
          }
          if ("say" in step) {
            const said = typeof step.say === "function" ? step.say(context()) : step.say;
            text += said;
            yield { type: "text", text: said };
          } else if ("call" in step) {
            if (!afterCall && modelSteps >= maxSteps) {
              stopReason = "max_steps";
              break;
            }
            afterCall = true;
            const input = typeof step.input === "function" ? step.input(context()) : step.input;
            const call = { id: `fake-${String(++callCount)}`, name: step.call, input: input ?? {} };
            yield { type: "tool_call", call };
            const outcome = conversationOptions.tools.tools.some((t) => t.name === step.call)
              ? await conversationOptions.tools.call(call, signal)
              : { content: `No such tool: ${step.call}`, isError: true };
            results.push(outcome);
            yield { type: "tool_result", callId: call.id, outcome };
          } else if ("fail" in step) {
            if (step.attempts === undefined || attempt < step.attempts) {
              throw new ModelError(step.fail, step.message ?? `Scripted failure: ${step.fail}`);
            }
          } else if ("wait" in step) {
            await sleep(step.wait, signal);
          } else {
            stopReason = step.stop;
          }
        }
        if (afterCall) modelSteps++;
        if (signal.aborted) throw abortReason(signal);

        record.messages.push(message);
        turnIndex++;
        attempt = 0;
        yield {
          type: "done",
          result: { text, stopReason, usage: estimateUsage(message, text), steps: modelSteps },
        };
      } catch (error) {
        attempt++;
        throw error;
      } finally {
        busy = false;
      }
    }

    return Promise.resolve({
      send,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  }
}

/** About four characters a token: enough for a fake. */
function estimateUsage(input: string, output: string): Usage {
  return {
    inputTokens: Math.ceil(input.length / 4),
    outputTokens: Math.ceil(output.length / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
