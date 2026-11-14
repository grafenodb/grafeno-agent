/**
 * Measures what meaning adds to recall: stores the set's memories in the
 * real Grafeno (with their vectors), asks each question by words only, by
 * meaning only, and by both, and counts how often the right memory comes
 * first, and among the first three. Deletes what it stored. No plan usage:
 * the embeddings are computed on this computer.
 *
 *   npm run measure:meaning
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../src/config.js";
import { localEmbedder } from "../../src/embed/local.js";
import { normalize } from "../../src/memory/quality.js";
import { answerId, grafenoVault } from "../../src/memory/vault.js";
import { MEMORIES, QUESTIONS, type QuestionKind } from "./meaning-set.js";

/** Words only, meaning only, both (Grafeno fuses by scores, its default), both fused by rank. */
type Mode = "text" | "vector" | "hybrid" | "hybrid-rank";
const MODES: readonly Mode[] = ["text", "vector", "hybrid", "hybrid-rank"];
const KINDS: readonly (QuestionKind | "all")[] = ["all", "words", "paraphrase", "crosslingual"];

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const vault = grafenoVault(config);
const embedder = localEmbedder("e5-small");
const run = randomUUID().slice(0, 8);
const ids: string[] = [];

try {
  const vectors = await embedder.embed([...MEMORIES], "passage");
  for (const [index, text] of MEMORIES.entries()) {
    const answer = await vault.call("remember", {
      text,
      labels: ["Fact", `Eval_${run}`],
      embedding: vectors[index],
    });
    const id = answerId(answer);
    if (answer.isError || id === undefined) throw new Error(`remember failed: ${answer.text}`);
    ids.push(id);
  }

  const questionVectors = await embedder.embed(
    QUESTIONS.map((q) => q.text),
    "query",
  );
  const hits: Record<Mode, { kind: QuestionKind; rank: number }[]> = {
    text: [],
    vector: [],
    hybrid: [],
    "hybrid-rank": [],
  };
  const misses: string[] = [];
  for (const [index, question] of QUESTIONS.entries()) {
    for (const mode of MODES) {
      const answer = await vault.call("recall", {
        query: question.text,
        labels: [`Eval_${run}`],
        limit: 10,
        depth: 0,
        mode: mode === "hybrid-rank" ? "hybrid" : mode,
        ...(mode === "hybrid-rank" ? { fusion: "rank" } : {}),
        ...(mode === "text" ? {} : { embedding: questionVectors[index] }),
      });
      const results =
        ((answer.data ?? JSON.parse(answer.text)) as { results?: { id: string }[] }).results ?? [];
      const rank = results.findIndex((r) => r.id === ids[question.answer]) + 1;
      hits[mode].push({ kind: question.kind, rank });
      if (mode === "hybrid-rank" && rank !== 1) {
        misses.push(
          `- (${question.kind}) "${question.text}": rank ${rank === 0 ? "none" : String(rank)}`,
        );
      }
    }
  }

  // What the agent really gives the model before each message: `context`
  // (600 tokens), with words only and with meaning too.
  const inContext: Record<"words" | "meaning", { kind: QuestionKind; found: boolean }[]> = {
    words: [],
    meaning: [],
  };
  for (const [index, question] of QUESTIONS.entries()) {
    for (const how of ["words", "meaning"] as const) {
      const answer = await vault.call("context", {
        query: question.text,
        labels: [`Eval_${run}`],
        budget: 600,
        ...(how === "meaning" ? { embedding: questionVectors[index] } : {}),
      });
      const wanted = normalize(MEMORIES[question.answer] ?? "");
      inContext[how].push({ kind: question.kind, found: normalize(answer.text).includes(wanted) });
    }
  }

  const rate = (list: { rank: number }[], within: number) =>
    list.length === 0 ? 0 : list.filter((h) => h.rank > 0 && h.rank <= within).length / list.length;
  const pct = (x: number) => `${String(Math.round(x * 100))}%`;
  const lines = [
    `# Meaning vs words: recall measurement`,
    ``,
    `Date: ${new Date().toISOString().slice(0, 10)}. Grafeno at ${config.grafenoUrl}; embedder ${embedder.name} (${String(embedder.dimension)} dimensions, local).`,
    `${String(MEMORIES.length)} memories, ${String(QUESTIONS.length)} questions (10 sharing words, 10 paraphrased, 10 in the other language). Recall with depth 0 (no graph expansion), top 10.`,
    ``,
    `| Questions | Mode | Right memory first | In the first three |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const kind of KINDS) {
    for (const mode of MODES) {
      const list = kind === "all" ? hits[mode] : hits[mode].filter((h) => h.kind === kind);
      lines.push(`| ${kind} | ${mode} | ${pct(rate(list, 1))} | ${pct(rate(list, 3))} |`);
    }
  }
  lines.push(
    ``,
    `What the agent gives the model before each message (\`context\`, 600 tokens): is the right memory in it?`,
    ``,
    `| Questions | Words only | With meaning |`,
    `| --- | --- | --- |`,
  );
  for (const kind of KINDS) {
    const share = (list: { kind: QuestionKind; found: boolean }[]) => {
      const kept = kind === "all" ? list : list.filter((h) => h.kind === kind);
      return pct(kept.filter((h) => h.found).length / kept.length);
    };
    lines.push(`| ${kind} | ${share(inContext.words)} | ${share(inContext.meaning)} |`);
  }
  lines.push(
    ``,
    `Questions hybrid-rank did not answer first:`,
    ``,
    ...(misses.length ? misses : ["- none"]),
  );
  const report = lines.join("\n");
  console.log(report);
  mkdirSync("docs/measurements", { recursive: true });
  const file = `docs/measurements/meaning-${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(file, `${report}\n`);
  console.log(`\nWritten to ${file}`);
} finally {
  for (const id of ids) await vault.call("forget", { id, mode: "delete" });
}
