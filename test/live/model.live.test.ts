import { ClaudeCodeModel, resilient } from "../../src/model/index.js";
import { describeModelContract } from "../model/contract.js";

// The same contract the fake model passes, run on Claude through the user's
// own Claude Code login. It spends a little of the plan's usage: it runs only
// with `npm run test:live:model`. `CLAUDE_MODEL` picks the model (default
// haiku, the lightest).
const claudeModel = process.env.CLAUDE_MODEL ?? "haiku";

describeModelContract(`claude-code (${claudeModel})`, () =>
  resilient(new ClaudeCodeModel({ model: claudeModel }), { turnTimeoutMs: 120_000, retries: 1 }),
);
