/**
 * Runs the evaluation suite and records its results.
 *
 *   npm run eval                       # the fake model: no plan usage, run in CI
 *   npm run eval:real                  # Claude through Claude Code (haiku): spends plan usage
 *   ... -- --embedder e5-small         # with meaning (downloads the local model once)
 *   ... -- --only preference           # one scenario
 *   ... -- --update-baseline           # accept these results as the new baseline
 *
 * Each run uses a Grafeno of its own, in memory (`grafeno serve --memory`).
 * Results go to docs/eval/: the latest per model, and a line in history.md.
 * It fails when a result falls below the baseline (test/eval/baseline.json):
 * a change to prompts or policy is measured before it lands.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { localEmbedder } from "../../src/embed/local.js";
import { ClaudeCodeModel, FakeModel, resilient } from "../../src/model/index.js";
import { startGrafeno } from "./grafeno-server.js";
import { runScenario, type ScenarioResult } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const modelName = option("model") ?? "fake";
const claudeModel = option("claude-model") ?? "haiku";
const embedderName = option("embedder") ?? "none";
const only = option("only");
const label = modelName === "fake" ? "fake" : `${modelName}:${claudeModel}`;
const key = embedderName === "none" ? label : `${label}+${embedderName}`;

interface Summary {
  readonly passed: number;
  readonly total: number;
  /** Share of what memory had to bring back that it did, 0 to 1. */
  readonly recall: number;
  readonly needless: number;
  readonly duplicatesRefused: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly msPerTurn: number;
}

function summarize(results: readonly ScenarioResult[]): Summary {
  const turns = results.flatMap((r) => r.turns);
  const expected = results.reduce((s, r) => s + r.recallExpected, 0);
  const found = results.reduce((s, r) => s + r.recallFound, 0);
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    recall: expected === 0 ? 1 : Math.round((found / expected) * 1000) / 1000,
    needless: results.reduce((s, r) => s + r.needless, 0),
    duplicatesRefused: results.reduce((s, r) => s + r.duplicatesRefused, 0),
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    cacheTokens: turns.reduce((s, t) => s + t.cacheTokens, 0),
    msPerTurn:
      turns.length === 0 ? 0 : Math.round(turns.reduce((s, t) => s + t.ms, 0) / turns.length),
  };
}

function commit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}+changes` : sha;
  } catch {
    return "unknown";
  }
}

const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
if (scenarios.length === 0) throw new Error(`No scenario ${String(only)}`);

const grafeno = await startGrafeno();
const runId = randomUUID().slice(0, 6);
const embedder = embedderName === "e5-small" ? localEmbedder("e5-small") : undefined;
const results: ScenarioResult[] = [];
try {
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, {
      grafenoUrl: grafeno.url,
      runId,
      ...(embedder ? { embedder } : {}),
      model: (script) =>
        modelName === "fake"
          ? new FakeModel({ turns: script.length > 0 ? script : [[{ say: "" }]] })
          : resilient(new ClaudeCodeModel({ model: claudeModel }), {
              turnTimeoutMs: 180_000,
              retries: 1,
            }),
    });
    results.push(result);
    console.log(`${result.passed ? "pass" : "FAIL"}  ${scenario.id}`);
    for (const failure of result.failures) console.log(`      ${failure}`);
  }
} finally {
  await grafeno.stop();
}

const summary = summarize(results);
const pct = (x: number) => `${String(Math.round(x * 100))}%`;
console.log(
  `\n${label}${embedderName === "none" ? "" : ` with ${embedderName}`}: ${String(summary.passed)}/${String(summary.total)} passed; recall ${pct(summary.recall)}; needless memories ${String(summary.needless)}; duplicates refused ${String(summary.duplicatesRefused)}; tokens ${String(summary.inputTokens)} in (+${String(summary.cacheTokens)} cache), ${String(summary.outputTokens)} out; ${String(summary.msPerTurn)} ms a turn.`,
);

// Record.
const date = new Date().toISOString();
mkdirSync("docs/eval", { recursive: true });
const slug = key.replace(/[^a-z0-9+.-]+/gi, "-");
writeFileSync(
  `docs/eval/latest-${slug}.json`,
  `${JSON.stringify({ date, commit: commit(), model: key, summary, results }, null, 2)}\n`,
);
const history = "docs/eval/history.md";
if (!existsSync(history)) {
  writeFileSync(
    history,
    "# Evaluation history\n\n| Date | Commit | Model | Passed | Recall | Needless | Duplicates refused | Tokens in+cache/out | ms a turn |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n",
  );
}
if (!only) {
  appendFileSync(
    history,
    `| ${date.slice(0, 16).replace("T", " ")} | ${commit()} | ${key} | ${String(summary.passed)}/${String(summary.total)} | ${pct(summary.recall)} | ${String(summary.needless)} | ${String(summary.duplicatesRefused)} | ${String(summary.inputTokens)}+${String(summary.cacheTokens)}/${String(summary.outputTokens)} | ${String(summary.msPerTurn)} |\n`,
  );
}

// Compare with the baseline.
const baselineFile = "test/eval/baseline.json";
const baselines = existsSync(baselineFile)
  ? (JSON.parse(readFileSync(baselineFile, "utf8")) as Record<
      string,
      Pick<Summary, "passed" | "recall" | "needless">
    >)
  : {};
if (args.includes("--update-baseline") && !only) {
  baselines[key] = { passed: summary.passed, recall: summary.recall, needless: summary.needless };
  writeFileSync(baselineFile, `${JSON.stringify(baselines, null, 2)}\n`);
  console.log(`Baseline for ${key} updated.`);
}
const baseline = baselines[key];
const regressions: string[] = [];
if (baseline && !only) {
  if (summary.passed < baseline.passed) {
    regressions.push(`passed ${String(summary.passed)} < baseline ${String(baseline.passed)}`);
  }
  if (summary.recall < baseline.recall) {
    regressions.push(`recall ${pct(summary.recall)} < baseline ${pct(baseline.recall)}`);
  }
  if (summary.needless > baseline.needless) {
    regressions.push(
      `needless ${String(summary.needless)} > baseline ${String(baseline.needless)}`,
    );
  }
}
if (regressions.length > 0) {
  console.log(`\nBelow the baseline: ${regressions.join("; ")}`);
  process.exitCode = 1;
} else if (modelName === "fake" && summary.passed < summary.total) {
  // The fake model does each scenario as scripted: any failure is the agent's.
  console.log("\nA scenario fails on the fake model.");
  process.exitCode = 1;
} else if (!baseline) {
  console.log(`\nNo baseline for ${key} yet: --update-baseline records one.`);
}
