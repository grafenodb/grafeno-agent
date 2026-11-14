import { ClaudeCodeModel } from "./claude-code.js";
import { resilient, type ResilienceOptions } from "./resilient.js";
import type { Model } from "./types.js";

export * from "./types.js";
export { ModelError, type ModelErrorKind } from "./errors.js";
export { collectTurn, type CollectedTurn } from "./turn.js";
export { resilient, type ResilienceOptions } from "./resilient.js";
export { FakeModel, type FakeStep, type FakeTurn, type FakeContext } from "./fake.js";
export { ClaudeCodeModel, type ClaudeCodeOptions } from "./claude-code.js";

/** The models the agent can run with, by the name `AGENT_MODEL` gives. */
export const MODEL_NAMES = ["claude-code"] as const;

export interface CreateModelOptions extends ResilienceOptions {
  /** For `claude-code`: the Claude model alias (`haiku`, `sonnet`, `opus`…). */
  readonly claudeModel?: string;
}

/** The model named by the settings, with time limits and retries. */
export function createModel(name: string, options: CreateModelOptions = {}): Model {
  switch (name) {
    case "claude-code":
      return resilient(
        new ClaudeCodeModel(
          options.claudeModel === undefined ? {} : { model: options.claudeModel },
        ),
        options,
      );
    default:
      throw new Error(`Unknown model "${name}". Known: ${MODEL_NAMES.join(", ")}`);
  }
}
