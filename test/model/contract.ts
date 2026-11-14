import { describe, expect, it } from "vitest";
import { collectTurn, type FakeTurn, type Model, type ModelEvent } from "../../src/model/index.js";
import { RecordingToolHost } from "./tool-host.js";

/**
 * What every model must do, phrased so a real model does it from the
 * words alone; `fake` scripts the same turns for the fake model.
 */
export interface ContractCase {
  readonly name: string;
  readonly system: string;
  readonly tools: () => RecordingToolHost;
  readonly messages: readonly string[];
  readonly fake: readonly FakeTurn[];
  readonly check: (outcome: {
    texts: readonly string[];
    events: readonly ModelEvent[][];
    host: RecordingToolHost;
    stopReasons: readonly string[];
    outputTokens: readonly number[];
  }) => void;
}

const SYSTEM =
  "You are a test fixture. Follow each instruction exactly. Answer with only what is asked, no other words.";

export const CONTRACT: readonly ContractCase[] = [
  {
    name: "answers a message",
    system: SYSTEM,
    tools: () => new RecordingToolHost(),
    messages: ["Reply with the single word PONG."],
    fake: [[{ say: "PONG" }]],
    check: ({ texts, stopReasons, outputTokens }) => {
      expect(texts[0]).toMatch(/PONG/);
      expect(stopReasons[0]).toBe("end_turn");
      expect(outputTokens[0]).toBeGreaterThan(0);
    },
  },
  {
    name: "calls a tool and uses what it returns",
    system: SYSTEM,
    tools: () =>
      new RecordingToolHost({
        get_secret_word: {
          spec: {
            description: "Returns the secret word.",
            inputSchema: { type: "object", properties: {} },
            writes: false,
          },
          run: () => ({ content: "grafeno-42" }),
        },
      }),
    messages: ["Call the get_secret_word tool, then reply with the secret word only."],
    fake: [[{ call: "get_secret_word" }, { say: (c) => c.results[0]?.content ?? "" }]],
    check: ({ texts, events, host }) => {
      expect(host.calls.map((c) => c.name)).toEqual(["get_secret_word"]);
      const types = (events[0] ?? []).map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types.at(-1)).toBe("done");
      expect(texts[0]).toMatch(/grafeno-42/);
    },
  },
  {
    name: "passes the tool its arguments",
    system: SYSTEM,
    tools: () =>
      new RecordingToolHost({
        add: {
          spec: {
            description: "Adds two numbers.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
            writes: false,
          },
          run: (input) => ({ content: String(Number(input.a) + Number(input.b)) }),
        },
      }),
    messages: ["Use the add tool to add 17 and 25, then reply with the resulting number only."],
    fake: [[{ call: "add", input: { a: 17, b: 25 } }, { say: (c) => c.results[0]?.content ?? "" }]],
    check: ({ texts, host }) => {
      expect(host.calls).toHaveLength(1);
      expect(host.calls[0]?.input).toEqual({ a: 17, b: 25 });
      expect(texts[0]).toMatch(/42/);
    },
  },
  {
    name: "keeps the conversation across turns",
    system: SYSTEM,
    tools: () => new RecordingToolHost(),
    messages: [
      "Remember this code word: ZINNIA. Reply with OK only.",
      "What was the code word? Reply with the word only.",
    ],
    fake: [[{ say: "OK" }], [{ say: (c) => c.history.join(" ").match(/ZINNIA/)?.[0] ?? "?" }]],
    check: ({ texts }) => {
      expect(texts[1]).toMatch(/ZINNIA/);
    },
  },
];

/** Runs the contract against a model made for each case. */
export function describeModelContract(label: string, makeModel: (c: ContractCase) => Model): void {
  describe(`model contract: ${label}`, () => {
    for (const c of CONTRACT) {
      it(c.name, async () => {
        const host = c.tools();
        const conversation = await makeModel(c).open({ system: c.system, tools: host });
        try {
          const texts: string[] = [];
          const events: ModelEvent[][] = [];
          const stopReasons: string[] = [];
          const outputTokens: number[] = [];
          for (const message of c.messages) {
            const turn = await collectTurn(conversation.send(message));
            texts.push(turn.result.text);
            events.push([...turn.events]);
            stopReasons.push(turn.result.stopReason);
            outputTokens.push(turn.result.usage.outputTokens);
          }
          c.check({ texts, events, host, stopReasons, outputTokens });
        } finally {
          await conversation.close();
        }
      });
    }
  });
}
