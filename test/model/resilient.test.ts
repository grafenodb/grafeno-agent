import { describe, expect, it } from "vitest";
import {
  FakeModel,
  ModelError,
  collectTurn,
  resilient,
  type FakeTurn,
} from "../../src/model/index.js";
import { backoffDelay } from "../../src/model/resilient.js";
import { RecordingToolHost } from "./tool-host.js";

const noWait = () => Promise.resolve();

async function open(turns: FakeTurn[], options: Parameters<typeof resilient>[1] = {}) {
  const fake = new FakeModel({ turns });
  const host = new RecordingToolHost({
    note: {
      spec: { description: "", inputSchema: { type: "object" }, writes: true },
      run: () => ({ content: "noted" }),
    },
  });
  const model = resilient(fake, { sleep: noWait, ...options });
  const conversation = await model.open({ system: "s", tools: host });
  return { conversation, host, fake };
}

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error("expected a ModelError");
}

describe("resilient", () => {
  it("tries a turn again after a retryable failure, then succeeds", async () => {
    const retries: number[] = [];
    const { conversation } = await open(
      [[{ fail: "unavailable", attempts: 2 }, { say: "hello" }]],
      { onRetry: (_e, attempt) => retries.push(attempt) },
    );
    const turn = await collectTurn(conversation.send("hi"));
    expect(turn.result.text).toBe("hello");
    expect(retries).toEqual([1, 2]);
  });

  it("gives up after the retries allowed", async () => {
    const { conversation } = await open([[{ fail: "unavailable" }]], { retries: 2 });
    const error = await failure(collectTurn(conversation.send("hi")));
    expect(error.kind).toBe("unavailable");
  });

  it("never retries once a tool has run, so no write happens twice", async () => {
    const { conversation, host } = await open([
      [{ call: "note" }, { fail: "unavailable", attempts: 1 }, { say: "done" }],
    ]);
    const error = await failure(collectTurn(conversation.send("hi")));
    expect(error.kind).toBe("unavailable");
    expect(host.calls).toHaveLength(1);
  });

  it("never retries a usage limit", async () => {
    let retried = false;
    const { conversation } = await open([[{ fail: "usage_limit", attempts: 1 }, { say: "x" }]], {
      onRetry: () => {
        retried = true;
      },
    });
    const error = await failure(collectTurn(conversation.send("hi")));
    expect(error.kind).toBe("usage_limit");
    expect(retried).toBe(false);
  });

  it("stops a turn that takes too long", async () => {
    const { conversation } = await open([[{ wait: 5_000 }, { say: "late" }]], {
      turnTimeoutMs: 20,
    });
    const error = await failure(collectTurn(conversation.send("hi")));
    expect(error.kind).toBe("timeout");
  });

  it("cancels a turn when asked", async () => {
    const { conversation } = await open([[{ wait: 5_000 }, { say: "late" }]]);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);
    const error = await failure(
      collectTurn(conversation.send("hi", { signal: controller.signal })),
    );
    expect(error.kind).toBe("cancelled");
  });

  it("waits longer each time, never more than the maximum", () => {
    const max = () => 1;
    expect(backoffDelay(0, 1000, 30_000, max)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, max)).toBe(8000);
    expect(backoffDelay(10, 1000, 30_000, max)).toBe(30_000);
    expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(0);
  });
});

describe("FakeModel", () => {
  it("stops calling tools at the step limit", async () => {
    const fake = new FakeModel({
      turns: [[{ call: "note" }, { say: "a" }, { call: "note" }, { say: "b" }]],
    });
    const host = new RecordingToolHost({
      note: {
        spec: { description: "", inputSchema: { type: "object" }, writes: false },
        run: () => ({ content: "ok" }),
      },
    });
    const conversation = await fake.open({ system: "s", tools: host, maxSteps: 2 });
    const turn = await collectTurn(conversation.send("go"));
    expect(turn.result.stopReason).toBe("max_steps");
    expect(host.calls).toHaveLength(1);
  });

  it("records what each conversation was sent", async () => {
    const fake = new FakeModel({ turns: [[{ say: "ok" }]] });
    const conversation = await fake.open({ system: "rules", tools: new RecordingToolHost() });
    await collectTurn(conversation.send("one"));
    await collectTurn(conversation.send("two"));
    expect(fake.conversations).toEqual([{ system: "rules", messages: ["one", "two"] }]);
  });
});
