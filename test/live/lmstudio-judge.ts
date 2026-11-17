/**
 * The check judge on a real local model (not part of the test suite): the
 * two wrong checks a leader wrote in a real run, judged by that leader.
 *
 *   LMSTUDIO_URL=http://localhost:1235/v1 npx tsx test/live/lmstudio-judge.ts
 */
import { judgeChecks } from "../../src/orchestrator/checks-repair.js";
import type { TaskSpec } from "../../src/orchestrator/plan.js";
import { LocalProvider } from "../../src/providers/local/provider.js";

const url = process.env.LMSTUDIO_URL ?? "http://localhost:1235/v1";
const model = new LocalProvider({
  id: "lmstudio",
  kind: "lmstudio",
  name: "LM Studio",
  url,
}).create({
  model: process.env.LEADER_MODEL ?? "google/gemma-4-e4b",
});

const greeting =
  "cat greeting.txt | grep -q 'hello' && wc -c < greeting.txt | awk '{print $1}' == 5";
const notes = "cat NOTES.md | wc -l | grep -q '1'";
const cases: { task: TaskSpec; doubt: "broken" | "disputed"; diagnostic: string; diff: string }[] =
  [
    {
      task: task(
        "create-greeting-txt",
        "Create greeting.txt containing exactly the word hello on one line.",
        greeting,
      ),
      doubt: "broken",
      diagnostic: `These checks failed; fix the work so that they pass:\n- \`${greeting}\` exited 2:\nawk: fatal: cannot open file \`==' for reading: No such file or directory`,
      diff: "diff --git a/greeting.txt b/greeting.txt\nnew file mode 100644\n--- /dev/null\n+++ b/greeting.txt\n@@ -0,0 +1 @@\n+hello\n",
    },
    {
      task: task(
        "create-notes-md",
        "Create NOTES.md with one sentence saying what greeting.txt is for.",
        notes,
      ),
      doubt: "disputed",
      diagnostic: `These checks failed; fix the work so that they pass:\n- \`${notes}\` exited 1:\n`,
      diff: "diff --git a/NOTES.md b/NOTES.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+greeting.txt holds the greeting the project prints.\n\\ No newline at end of file\n",
    },
  ];
for (const c of cases) {
  const started = Date.now();
  const judged = await judgeChecks(model, c.task, c.doubt, c.diagnostic, c.diff);
  console.log(
    `${c.task.id} (${c.doubt}, ${String(Math.round((Date.now() - started) / 1000))} s): ${JSON.stringify(judged)}`,
  );
}

function task(id: string, description: string, run: string): TaskSpec {
  return {
    id,
    title: id,
    description,
    kind: "docs",
    dependsOn: [],
    complexity: 1,
    capabilities: ["code"],
    touches: [],
    acceptance: [{ check: "command", run }],
    parallelSafe: true,
  };
}
