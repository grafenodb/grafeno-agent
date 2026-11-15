# First real orchestration runs (phase A, D5)

Date: 2026-11-15. Claude through Claude Code (the user's Pro plan), Grafeno
0.3.0 on 127.0.0.1:7810, Node 26.13.1, Windows 11. Command:

```bash
grafeno-agent run "<request>" --light --yes
```

The mode was `controlled`, with up to 3 workers. `--light` means the light
tier at low effort for every task, unless the complexity floor raises a
task.

The project was `slugkit`: a fresh git repository with `package.json`
(`"type": "module"`, `"test": "node --test"`), a one-line README, and empty
`src/` and `test/`. The request:

> Build slugkit, a tiny ES module with no dependencies, in three tasks:
> (1) src/slug.js exporting slugify(text) …; (2) test/slug.test.js with
> node:test cases …, accepted when 'node --test' passes; (3) a Usage section
> in README.md …

The planner made three tasks: `slug-module` (backend), and after it, at
the same time, `slug-tests` (tests) and `readme-usage` (docs). Each had
checks by code: files, `node -e …` commands, and `node --test`.

## Run 1 — `run-2026-11-15-e9a887c2`: failed, and found two bugs

| Task           | Model      | Attempts | Result                     |
| -------------- | ---------- | -------- | -------------------------- |
| `slug-module`  | haiku, low | 1        | merged                     |
| `slug-tests`   | haiku, low | 3        | failed: `node --test` exit 1 |
| `readme-usage` | haiku, low | 1        | merged                     |

Totals: 5 attempts, 38 input, 6.9k output and 259.4k cache tokens, 54 s of
work (about 1.5 min of wall clock with planning). There were 3 questions
for a person, each refused because nobody was there to answer.

The run found two bugs, neither of which the fake-model tests had shown:

1. **A dependant did not see its dependencies' work.** Every task's
   worktree was made from the run's base commit, so `slug-tests` had no
   `src/slug.js`: `ERR_MODULE_NOT_FOUND`, three times, until it failed.
   (The docs worker also said the file was missing in its view.)
2. **Workers could not run their own checks.** In `controlled`, only the
   fixed list of checks and builds ran without asking. The plan's
   `node -e "…"` acceptance commands were asked about and, with nobody to
   ask, refused. The workers then reported their work as unconfirmed.

Fixes, with tests that fail without them
(`test/orchestrator/orchestrator.test.ts`,
`test/orchestrator/worktrees.test.ts`):

- **Where a task starts:** a task's worktree starts from the integration
  branch's tip once there is one, which includes everything merged before
  it (`WorktreeManager.tip`, `TaskPipeline.workspaceFor`).
- **What a task changed:** this is measured from the commit its branch
  was made from (the branch's reflog), so a dependency's files are not
  counted as the task's own, before or after the merge.
- **A task's own checks:** in `controlled`, a worker may run its task's
  own acceptance commands, exactly as written; the verifier runs them
  anyway (`Policy.command(command, ownChecks)`). Sensitive commands are
  still always asked, and `supervised` still asks for every command.
- **When conflicts happen:** two tasks touching the same file no longer
  conflict when one runs after the other; the second builds on the first.
  Conflicts are still found, and sent to review, for tasks that ran at
  the same time.

## Run 2 — `run-2026-11-15-fd68748d`: completed

| Task           | Model       | Attempts | Result |
| -------------- | ----------- | -------- | ------ |
| `slug-module`  | sonnet, low | 1        | merged |
| `slug-tests`   | haiku, low  | 1        | merged |
| `readme-usage` | haiku, low  | 1        | merged |

Totals: 3 attempts, 26 input, 3.9k output and 172.0k cache tokens, 31 s of
work, 50 s of wall clock with planning. `slug-tests` and `readme-usage`
ran at the same time.

This time the planner rated `slug-module` complex enough that the
complexity floor kept it off the light tier, so it ran on Sonnet.

There was 1 question for a person: the docs worker wanted to run an ad-hoc
example (not one of its checks), and was refused; it worked the output out
by hand.

Checked afterwards:

- **The integration branch:** `grafeno/fd68748d/integration` holds three
  merge commits, one per task. Each task commit is authored by its worker
  (`Grafeno Agent (worker-fd68748d-<task>-1)`). It changes `src/slug.js`,
  `test/slug.test.js` and `README.md` (64 lines in all).
- **The tests:** `node --test` on that branch gives 8 tests, 8 passed.
- **The user's branch:** `main` and its working tree are untouched (no
  changes, still at the first commit).
- **Memory:** Grafeno holds one checkpoint per task under the run, in the
  project's palace. The workers stored no memories of their own for this
  small task; sharing decisions between workers is shown by
  `npm run eval:orchestration`.

Cost to the plan: about 431k cache, 10.8k output and 64 input tokens for
both runs together, almost all of it cache reads. That is a small share of
a five-hour window.
