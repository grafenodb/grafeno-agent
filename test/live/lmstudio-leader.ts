/**
 * A real orchestrated run on LM Studio (not part of the test suite): two
 * local models, one leading. It plans a small request, the router chooses
 * each task's model (the leader's recommendation is advice), workers do the
 * work in worktrees, checks run by code, and the leader audits by risk.
 *
 *   LMSTUDIO_URL=http://localhost:1235/v1 npx tsx test/live/lmstudio-leader.ts
 *
 * Nothing is mocked: the models, the files and the checks are real. The
 * run's folder and data are temporary.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePlan } from "../../src/app/orchestrate.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { describeResult } from "../../src/orchestrator/result.js";
import { describeDecision, type Decision } from "../../src/orchestrator/sufficient.js";
import { describeDecisionsSummary } from "../../src/orchestrator/routing-report.js";
import { LocalProvider } from "../../src/providers/local/provider.js";

const url = process.env.LMSTUDIO_URL ?? "http://localhost:1235/v1";
const leaderModel = process.env.LEADER_MODEL ?? "google/gemma-4-e4b";

const dir = mkdtempSync(join(tmpdir(), "ga-lmstudio-"));
const repo = join(dir, "project");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
git("config", "user.name", "Test");
git("config", "user.email", "test@example.invalid");
writeFileSync(join(repo, "README.md"), "# Greeter\n\nA tiny project to try the orchestrator.\n");
git("add", "-A");
git("commit", "-q", "-m", "start");

const provider = new LocalProvider({ id: "lmstudio", kind: "lmstudio", name: "LM Studio", url });
console.log(`Status: ${(await provider.status()).detail}`);
console.log(`Models: ${(await provider.models()).map((m) => m.id).join(", ")}\n`);

let seed = 7;
const orchestrator = new Orchestrator({
  provider,
  project: { name: "lmstudio-try", path: repo },
  projectRoot: repo,
  dataDir: join(dir, "data"),
  metrics: false,
  routing: "balanced",
  router: "learned",
  // Reproducible exploration.
  explore: {
    share: 0.1,
    random: () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    },
  },
  leader: { provider: "lmstudio", model: leaderModel },
  mode: "extended",
  maxWorkers: 1,
  attemptTimeoutMs: 15 * 60 * 1000,
  ask: () => Promise.resolve(false),
});

const request =
  "Create a file greeting.txt that contains exactly the word hello on one line, and a file NOTES.md with one sentence saying what greeting.txt is for.";
const started = Date.now();
const planned = await orchestrator.plan(request);
console.log("Plan:");
for (const line of describePlan(planned)) console.log(`  ${line}`);
const { run } = await orchestrator.start(request, planned);
const state = await orchestrator.run(run.id);
const events = orchestrator.store.events(run.id);
console.log(`\nRun ${run.id}: ${state} in ${String(Math.round((Date.now() - started) / 1000))} s`);
const result = describeResult(orchestrator.store.tasks(run.id), events, state);
console.log(result.headline);
for (const line of result.tasks) console.log(`  ${line}`);
const decisions = events.filter((e) => e.kind === "route_decision");
console.log("\nRouting decisions:");
for (const e of decisions) {
  console.log(`  ${e.taskId ?? "?"} · attempt ${String(e.data.attempt)}`);
  for (const line of describeDecision(e.data as unknown as Decision)) console.log(`    ${line}`);
}
for (const line of describeDecisionsSummary(decisions.map((e) => e.data as unknown as Decision))) {
  console.log(line);
}
const audits = events.filter((e) => e.kind === "reviewed");
console.log(`\nLeader audits: ${String(audits.length)}`);
for (const a of audits) {
  console.log(`  ${a.taskId ?? "?"}: ${String(a.data.verdict)} by ${String(a.data.reviewer)}`);
}
const routed = events.filter((e) => e.kind === "attempt_metrics");
console.log("\nAttempts:");
for (const a of routed) {
  console.log(
    `  ${a.taskId ?? "?"} #${String(a.data.attempt)}: ${String(a.data.model)} · ${String(a.data.outcome)} · ${String(Math.round(Number(a.data.ms) / 1000))} s · ${String(a.data.inputTokens)} in / ${String(a.data.outputTokens)} out tokens`,
  );
}
try {
  console.log(
    `\nOn the integration branch:\n${git("ls-tree", "-r", "--name-only", orchestrator.integrationBranch(run.id))}`,
  );
  console.log(
    `greeting.txt: ${JSON.stringify(git("show", `${orchestrator.integrationBranch(run.id)}:greeting.txt`))}`,
  );
} catch (error) {
  console.log(
    `\n(no work merged: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`,
  );
}
orchestrator.close();
console.log(`\nFolder: ${repo}`);
