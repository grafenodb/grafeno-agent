import { ModelError } from "./errors.js";
import type { ModelEvent, TurnResult } from "./types.js";

export interface CollectedTurn {
  readonly result: TurnResult;
  readonly events: readonly ModelEvent[];
}

/** Reads a whole turn: every event, and the result of its `done` event. */
export async function collectTurn(stream: AsyncIterable<ModelEvent>): Promise<CollectedTurn> {
  const events: ModelEvent[] = [];
  let result: TurnResult | undefined;
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done") result = event.result;
  }
  if (!result) throw new ModelError("failed", "The turn ended without a result");
  return { result, events };
}

/** An `AbortError`-like reason turned into the `ModelError` it stands for. */
export function abortReason(signal: AbortSignal): ModelError {
  const reason: unknown = signal.reason;
  if (reason instanceof ModelError) return reason;
  return new ModelError("cancelled", "The turn was cancelled", { cause: reason });
}
