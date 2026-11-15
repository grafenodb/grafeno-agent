import { ClaudeCodeModel, resilient } from "../../src/model/index.js";
import { CodexModel } from "../../src/model/codex.js";
import { describeModelContract } from "../model/contract.js";

// The same contract the fake model passes, run on real models through the
// user's own CLIs and plans. It spends a little of each plan: it runs only
// with `npm run test:live:model`. `LIVE_MODELS` picks which (default:
// claude-code); `CLAUDE_MODEL` and `CODEX_MODEL` pick the model (default:
// the lightest of each).
const which = (process.env.LIVE_MODELS ?? "claude-code").split(",").map((s) => s.trim());

if (which.includes("claude-code")) {
  const claudeModel = process.env.CLAUDE_MODEL ?? "haiku";
  describeModelContract(`claude-code (${claudeModel})`, () =>
    resilient(new ClaudeCodeModel({ model: claudeModel }), { turnTimeoutMs: 120_000, retries: 1 }),
  );
}

if (which.includes("codex")) {
  const codexModel = process.env.CODEX_MODEL ?? "gpt-6-luna";
  describeModelContract(`codex (${codexModel})`, () =>
    resilient(new CodexModel({ model: codexModel, effort: "low" }), {
      turnTimeoutMs: 180_000,
      retries: 1,
    }),
  );
}
