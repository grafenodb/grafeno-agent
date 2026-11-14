import { ModelError } from "./errors.js";
import { abortReason } from "./turn.js";
import type { Conversation, ConversationOptions, Model, ModelEvent, SendOptions } from "./types.js";

export interface ResilienceOptions {
  /** Longest a turn may take, tool calls included. Default: 10 minutes. */
  readonly turnTimeoutMs?: number;
  /** Times a turn is tried again after a retryable failure. Default: 3. */
  readonly retries?: number;
  /** First wait before trying again; it doubles each time. Default: 1 s. */
  readonly baseDelayMs?: number;
  /** Longest wait before trying again. Default: 30 s. */
  readonly maxDelayMs?: number;
  /** Told before each new try. */
  readonly onRetry?: (error: ModelError, attempt: number, delayMs: number) => void;
  /** For tests: how to wait, and the source of jitter. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

const DEFAULTS = {
  turnTimeoutMs: 10 * 60_000,
  retries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** Waits `ms`, or rejects when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  return Math.round(Math.min(maxMs, baseMs * 2 ** attempt) * random());
}

/**
 * Wraps a model with a time limit per turn and retries with backoff. A turn
 * is tried again only when its failure is retryable and nothing of it was
 * seen yet (no text, no tool call), so no tool runs twice.
 */
export function resilient(model: Model, options: ResilienceOptions = {}): Model {
  const settings = { ...DEFAULTS, ...options };
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  return {
    name: model.name,
    async open(conversationOptions: ConversationOptions): Promise<Conversation> {
      const inner = await model.open(conversationOptions);
      return {
        close: () => inner.close(),
        send: (message, sendOptions) => sendResiliently(inner, message, sendOptions),
      };
    },
  };

  async function* sendResiliently(
    inner: Conversation,
    message: string,
    sendOptions: SendOptions = {},
  ): AsyncGenerator<ModelEvent> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(
          new ModelError(
            "timeout",
            `The turn took longer than ${String(settings.turnTimeoutMs)} ms`,
          ),
        );
      }, settings.turnTimeoutMs);
      const outer = sendOptions.signal;
      const onOuterAbort = () => {
        controller.abort(outer ? abortReason(outer) : undefined);
      };
      if (outer?.aborted) onOuterAbort();
      else outer?.addEventListener("abort", onOuterAbort, { once: true });

      let seen = false;
      try {
        for await (const event of inner.send(message, { signal: controller.signal })) {
          if (event.type !== "usage_windows") seen = true;
          yield event;
        }
        return;
      } catch (caught) {
        const error = controller.signal.aborted
          ? abortReason(controller.signal)
          : caught instanceof ModelError
            ? caught
            : new ModelError("failed", String(caught), { cause: caught });
        if (!error.retryable || seen || attempt >= settings.retries) throw error;
        const delay = backoffDelay(attempt, settings.baseDelayMs, settings.maxDelayMs, random);
        options.onRetry?.(error, attempt + 1, delay);
        await wait(delay, outer);
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onOuterAbort);
      }
    }
  }
}
