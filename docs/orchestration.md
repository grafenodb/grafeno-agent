# Orchestration: design and roadmap

Grafeno Agent today runs one agent: one conversation with one model. This
document is the plan for running several workers at once, under a
deterministic scheduler, with Grafeno as their shared memory. It starts
with what exists, then the design, the decisions still open, the roadmap
by phase, and the risks.

Status: **design; phase A in progress**. Phase A is the only phase to
be built now, with Claude Code as the only working provider.

## 1. What exists, and what it is reused for

| Piece                                                                                                                                                                       | Where                                          | Reused as                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model interface (`Model`, `Conversation`, events: text, tool calls, usage windows, `model_info`, `context`)                                                                 | `src/model/types.ts`                           | The only way a worker talks to a model. Nothing in the orchestrator sees Claude Code.                                                                                 |
| Claude Code adapter: the official `claude` binary, its own tools off, the agent's tools served over local MCP, `--model`, `--effort`, retries and time limits (`resilient`) | `src/model/claude-code.ts`, `resilient.ts`     | Each worker's model. Several can run at once: each is its own `claude` process.                                                                                       |
| Provider interface: status, models (exact names), efforts, real usage (`/usage`, free), `create(choice)`                                                                    | `src/providers/`                               | Discovering which models and efforts the installed CLI really has, and the plan's real quota, before and during a run. The seed of the capability registry (phase B). |
| Agent loop: turns, step limit, session token budget, restart when the model lost the conversation                                                                           | `src/agent/agent.ts`                           | The loop inside each worker.                                                                                                                                          |
| Tool registry with permissions (`free`, `ask`, `never`), argument validation, secret redaction in outputs                                                                   | `src/agent/tools.ts`, `validate.ts`            | Each worker's tools. Permissions are code, never prompts: a model cannot skip them.                                                                                   |
| Project tools (files, commands, web) confined to a `Workspace` root                                                                                                         | `src/tools/`                                   | A worker's tools, with the workspace rooted at its own worktree.                                                                                                      |
| Memory session: palace per project, context before each message, duplicate guard, secret filter, own-only keys, checkpoints, `recorded_by` per agent                        | `src/memory/`                                  | Each worker's memory, under its own name, in the project's shared palace.                                                                                             |
| Several agents (phase 9): one key per agent, `--own-only`, supersedes instead of overwriting, per-agent checkpoints, concurrency test                                       | `src/memory/session.ts`, `test/eval/agents.ts` | Workers as named agents: attribution and non-interference are already proven.                                                                                         |
| Agent session (memory, tools, model choice, kept conversation, carry-over of the earlier conversation as data)                                                              | `src/app/session.ts`, `src/sessions/store.ts`  | The base of a worker's session and of its renewal with reduced context.                                                                                               |
| Evaluation harness against Grafeno in memory, fake model                                                                                                                    | `test/eval/`                                   | The integration tests of the orchestrator.                                                                                                                            |
| Terminal interface                                                                                                                                                          | `src/tui/`                                     | Where a run is started, watched, paused and approved.                                                                                                                 |

**Missing:** a plan schema and its validation (DAG), the planner, the
scheduler and its persistent operational state, the worker manager, git
worktree isolation and integration, verification (checks run by code),
autonomy policies (`supervised` / `controlled` / `extended`), context
lifecycle and budget, telemetry, recovery after a restart.

**Limit of today's guard.** `run_command` decides permissions by reading
the command's words (`src/tools/command.ts`). That is a guard against
mistakes, not a sandbox: it does not contain a command that misbehaves.
See decision D2.

## 2. Architecture

```
 user request
      │
      ▼
 ┌─────────┐  plan (JSON)   ┌──────────────┐  valid DAG
 │ Planner │ ─────────────▶ │ Plan checker │ ───────────┐
 │ (LLM)   │ ◀── problems ─ │ (code)       │            │
 └─────────┘                └──────────────┘            ▼
                                              ┌───────────────────┐
     operational store (SQLite) ◀────────────▶│ Scheduler (code)  │
     runs, tasks, attempts, workers,          │ ready set, limits │
     worktrees, events, effects               └─────────┬─────────┘
                                                        │ assign
                     ┌────────────────┬─────────────────┼────────────────┐
                     ▼                ▼                 ▼                ▼
               ┌──────────┐     ┌──────────┐      ┌──────────┐     ┌──────────┐
               │ Worker 1 │     │ Worker 2 │      │ Worker 3 │ …   │ Verifier │
               │ Opus·high│     │Sonnet·med│      │Haiku·low │     │ (code)   │
               │ worktree │     │ worktree │      │ worktree │     │ checks   │
               └────┬─────┘     └────┬─────┘      └────┬─────┘     └────┬─────┘
                    │  own key, recorded_by            │                │
                    └────────────── Grafeno ───────────┘                ▼
                       decisions, contracts,                      ┌────────────┐
                       facts, checkpoints                         │ Integrator │
                                                                  │ (code)     │
                                                                  └────────────┘
```

- **The LLMs plan and do; code decides.** The planner proposes, the plan
  checker accepts or returns problems; the scheduler, the verifier, the
  integrator and the policy engine are code, and keep working when no model
  is running.
- **Two stores, never mixed.** Cognitive memory (decisions, contracts,
  facts, lessons, checkpoints) goes to Grafeno, as today. Operational state
  (runs, tasks, states, attempts, workers, worktrees, locks, effects) goes
  to a transactional store of the agent's own. The palace is never a queue.
- **Each worker is a named agent** (`grafeno-agent-<run>-<task>` or a role
  name), with the existing memory policy: what it stores is recorded under
  its name, and with an own-only key it cannot change another's memory.

### 2.1 Plan and DAG

The planner asks the model for a plan as JSON matching a schema, then the
checker validates it by code:

```ts
interface Plan {
  goal: string;
  tasks: TaskSpec[];
  risks: string[];
}

interface TaskSpec {
  id: string; // unique, [a-z0-9-]
  title: string;
  kind:
    "architecture" | "backend" | "frontend" | "tests" | "docs" | "refactor" | "debug" | "review";
  dependsOn: string[]; // ids in this plan
  complexity: 1 | 2 | 3 | 4 | 5;
  capabilities: string[]; // "code", "tools", "shell"…
  touches: string[]; // files or globs it expects to change
  acceptance: Acceptance[]; // at least one, each checkable
  parallelSafe: boolean;
  recommended?: { tier: "deep" | "standard" | "light"; effort?: string };
}

type Acceptance =
  | { check: "command"; run: string; expect: "exit0" } // typecheck, lint, test, build
  | { check: "files"; exist: string[] }
  | { check: "review"; by: "worker"; criteria: string }; // never enough alone
```

The checker refuses: unknown or duplicate ids, references to missing tasks,
cycles (topological sort), tasks without acceptance, a `review` as a task's
only acceptance, `touches` outside the project, commands the policy forbids.
Problems go back to the planner, a bounded number of times.

Models are named by **tier** (`deep`, `standard`, `light`), never by name:
the router maps a tier to what the provider really offers (§2.4).

### 2.2 Scheduler and states

```
pending ──deps done──▶ ready ──assigned──▶ running ──checks pass──▶ completed
   │                     ▲                   │  │
   │                     │ retry (bounded)   │  └──needs a person──▶ review ──approved──▶ completed
   │                     └───────────────────┤                          └──rejected──▶ failed
   └──a dependency failed──▶ blocked         ├──error, retries left──▶ ready
                                             ├──no retries / unrecoverable──▶ failed
 any state but completed ──cancel──▶ cancelled
```

- Transitions are a table in code; any other is refused and logged. Tests
  walk every allowed and forbidden transition.
- The ready set is computed from the DAG and the store, never from a
  model. Independent ready tasks run in parallel up to `maxWorkers`, and
  two tasks whose `touches` overlap never run at the same time on a shared
  workspace.
- Each attempt has a timeout and a token budget; cancellation reaches the
  worker's `AbortSignal` (the adapter already stops `claude` on abort).
- **Pause and resume**: the scheduler stops assigning; running attempts
  finish or are cancelled; state is in the store, so a new process resumes.
- **Irreversible effects** (merges, pushes, file deletions outside a
  worktree) are recorded in an `effects` table with an idempotency key
  _before_ they run and marked done after. On restart, an effect marked
  started but not done is checked against the world (is the commit
  there?) before anything is redone.

### 2.3 Workers

A worker is an `Agent` (today's loop) with:

- the provider's model for its tier and effort (`Provider.create`),
- a `Workspace` rooted at its own git worktree (§2.5),
- the project tools plus memory tools, under the policy of the run (§2.8),
- its own memory session and name in Grafeno,
- a budget (time, steps, tokens), a timeout, an `AbortSignal`,
- a prompt with its task, its acceptance, the decisions it depends on and
  references (paths, memory ids) rather than pasted text.

Profiles are configuration, not code: `architecture → deep, high`,
`backend → deep, high`, `frontend → standard`, `tests → light/standard,
low/medium`, `docs → light, low`. A profile names a tier and an effort;
the router checks both against what the CLI reports (`/model`, `/effort`).

### 2.4 Router (phase A: rules; phase C: learning)

Phase A: a fixed table from task kind and complexity to tier and effort,
the planner's recommendation as a hint, then **availability**: the
provider's models and efforts (discovered, cached), its sign-in, and its
real usage. With the plan's session limit near full, the router chooses
lighter tiers or holds new tasks; it never works around a limit. When a
tier is missing, an explicit fallback order (`deep → standard`,
`standard → light`) applies, and the choice is recorded.

### 2.5 Isolation and integration with git worktrees

- Each task that writes gets `git worktree add <data>/worktrees/<run>/<task>
-b grafeno/<run>/<task> <base>`, from a base commit fixed when the run
  starts. The user's working tree is never written by workers.
- When a task's checks pass, its branch is merged into the run's
  **integration branch** (`grafeno/<run>/integration`), in dependency
  order, by code: a conflict stops that task in `review` with the
  conflicting files; checks run again on the integration branch.
- Bringing the integration branch into the user's branch is decision D3.
- Worktrees are removed only when their branch is merged or the task is
  cancelled, and never with uncommitted changes.

### 2.6 Memory shared through Grafeno

- Before its task, a worker gets `context` for the task (its decisions,
  contracts, constraints), within the task's memory budget.
- An architecture task's output is stored as `Decision` and `Constraint`
  memories, related (`depends_on`, `part_of`) to the tasks that use them;
  the plan's tasks reference those memory ids.
- Workers store under their own names (`recorded_by`), correct by
  `supersedes`, save a checkpoint per task. Who produced what is answered by
  Grafeno, as phase 9 proved.
- Grafeno needs found here go to `D:\Codes\Personal\grafeno\GRAFENO_FIX.md`
  (fix #1 there, `context` scoped to a palace, matters for this).

### 2.7 Verification

Acceptance is checked by code: the verifier runs each `command` check in
the task's worktree (typecheck, lint, tests, build, contract checks), with
a time limit, and records exit code and output. A task is completed only
when its checks pass, never because the model said so. On failure, the
diagnostic (trimmed output) goes back to the same worker, at most
`maxFixes` times; then the task fails, and what depends on it is blocked.
Reviews by another worker are extra evidence, never a check by themselves.

### 2.8 Policies (autonomy)

A policy engine in code decides each action of each worker, on top of the
existing per-tool permissions:

| Action                                                         | supervised | controlled (default)                         | extended               |
| -------------------------------------------------------------- | ---------- | -------------------------------------------- | ---------------------- |
| Read in the worktree                                           | allow      | allow                                        | allow                  |
| Write in its own worktree                                      | ask        | allow                                        | allow                  |
| Commands that only read                                        | allow      | allow                                        | allow                  |
| Other commands in the worktree                                 | ask        | allow if listed (test, build, lint) else ask | allow                  |
| Merge into the integration branch                              | ask        | allow when checks pass                       | allow when checks pass |
| Merge into the user's branch                                   | ask        | ask                                          | allow when checks pass |
| Push, deploy, infrastructure, secrets, outside the project     | ask        | ask                                          | ask                    |
| Forbidden list (privileges, deleting everything, forced push…) | never      | never                                        | never                  |

Questions for the user are queued in the store and shown in the
interface; a worker waits (with its timeout) instead of guessing.

### 2.9 Context lifecycle and budget

- The adapter reports the context of each request and the model's window
  (`context` events). Thresholds per worker: warn at 60 %, renew at 80 %.
- Renewal happens only between turns, never in the middle of a tool call:
  the worker saves a checkpoint (Grafeno), the session closes, and a new
  one starts with the task, the checkpoint, the files touched (as paths)
  and the memory ids, not the old conversation. A summary is not assumed
  to keep everything: the checkpoint is checked to name files and next
  steps before the old session is dropped.
- Budgets per task: memory tokens (`context` budget), tool output size
  (already capped), turns and tokens per attempt. Reported tokens are kept
  apart from estimates.
- Tasks a tool can settle (a check, a file listing) are done by code
  without a model.

### 2.10 Telemetry

Every transition, attempt, assignment, check, effect and policy decision is
an event in the store: time, run, task, worker, model id, effort, tokens
(reported), duration, outcome, reason. No message text or tool output with
secrets: outputs are stored trimmed and redacted with the existing secret
filter. `grafeno-agent runs` and the interface read it.

## 3. Decisions

**Decided with the user (2026-11-14):** D1 (a) SQLite through
`node:sqlite`, with the project raised to Node 26 LTS (26.13 or later);
D2 (a) worktree and policies now, documented as not a sandbox; D3 (a) an
integration branch per run; D5 a small first real run (three workers,
light tier, low effort). D4 (a) follows from the store.

The options, as they were weighed:

**D1. Operational store.**

- (a) SQLite through Node's built-in `node:sqlite` (Node ≥ 22.13, works
  here on 24): transactions, no new dependency, one file per project in
  the agent's data folder. Risk: still marked experimental in Node 22.
- (b) JSON files with an append-only journal: no experimental API; more
  code for atomicity and recovery.
- (c) A Grafeno namespace: refused by principle (the palace is not a queue).

Recommended: (a), behind a small `OperationalStore` interface so (b) can
replace it.

**D2. Running untrusted commands.**

- (a) Worktree + policy engine + today's guard, documented as _not_ a
  sandbox; a `CommandRunner` interface so a real sandbox can be plugged in.
- (b) A real sandbox now: commands in a container (Docker / Podman) with
  the worktree mounted, no network unless allowed. Real containment;
  needs Docker on the user's computer, slower, Windows paths.
- (c) OS sandboxes (Windows Sandbox, AppContainer, firejail): per-OS work,
  fragile.

Recommended: (a) for phase A, with (b) as the first `CommandRunner`
alternative when the user has Docker; the README says plainly what (a)
does not protect from.

**D3. Where integrated work lands.**

- (a) An integration branch per run; the user merges it (or asks the agent
  to) after looking.
- (b) In `controlled`, merge into the user's current branch automatically
  when every check passes and the working tree is clean.

Recommended: (a) by default, (b) only in `extended`.

**D4. Where a run lives.**

- (a) Inside the interface's process for phase A (closing it pauses the
  run; reopening resumes it from the store).
- (b) A background supervisor process from the start (phase D.2).

Recommended: (a) now; the store makes (b) a later addition, not a rewrite.

**D5. Real runs on Claude.** Most tests use the fake model. Real runs spend
the user's plan; three workers at once spend about three times as fast.
Recommended first real run: three workers on a small task, light tier, low
effort (expected: a few percent of a five-hour window). Larger runs only
when asked.

## 4. Roadmap

### Phase A — several Claude Code workers (to build now)

Progress: **A1 done** (`src/orchestrator/plan.ts`, `planner.ts`: schema,
checker, planner with a bounded repair loop; 10 tests), **A2 done**
(`states.ts`, `store.ts`: the transition table and the SQLite store with
runs, tasks, events and once-only effects; 6 tests, including reopening the
file as a new process would) and **A3 done** (`scheduler.ts`: the
`TaskRunner` contract and the deterministic scheduler: ready set from the
DAG and the store, `maxWorkers`, `touches` locks, tasks that run alone,
timeouts that hold even when a runner ignores its signal, bounded retries,
failures that block their dependants, review that leaves the run
`waiting`, cancel, pause and resume, the provider's limit pausing the run
without spending the task's attempt, and recovery of attempts a dead
process left running; 13 tests) and **A4 done** (`router.ts`,
`workers.ts`: tier-based profiles per task kind, the planner's advice,
complexity floor, the provider's own tier→model mapping (`Provider.tiers`)
with a fixed fallback order, efforts lowered to what is offered, lighter
tiers above 80 % of a limit and a hold above 95 %; the `WorkerPool`
`TaskRunner`: each attempt an `Agent` with the routed model and effort,
its own workspace and name (`worker-<run>-<task>-<attempt>`), tools under
permissions (asks refused until the policy engine), a message with only the
task, its checks, its dependencies' reports and the last attempt's reason;
errors mapped to retry / failed / quota; 11 tests, three workers at once
with three different models and efforts). On the real Claude Code, without
spending: architecture and backend → Opus 5.5 high, frontend → Sonnet 5.5
medium, tests → Haiku 5.5 medium, docs → Haiku 5.5 low.

**A5 done** (`worktrees.ts`, `pipeline.ts`): `WorktreeManager` gives each
task a worktree and branch `grafeno/<run>/<task>` from the run's base
commit, commits a worker's changes with the worker as author, merges into
`grafeno/<run>/integration` in its own worktree (a conflict is undone and
its files returned; a merge that fails without conflicts is an error to
retry), checks whether a merge already happened before redoing it, and
removes a worktree only when nothing would be lost (the branches stay for
the user). Merges into one run and worktree creation run one at a time:
git's own locks made parallel merges look like conflicts. `TaskPipeline`
wraps the workers: worktree before, commit, verification hook (A7), merge as
a recorded effect, review on conflict, cleanup at the end; without git it
works in the project folder. 9 tests on a real temporary repository,
including the user's uncommitted change, HEAD and branch left untouched.

**A6 done** (`memory.ts`, and `MemorySession` options `author`, `brief`,
`register`, `stored`): each worker gets a memory session in the project's
shared palace with the usual guards; what it stores carries its name as
`props.author` (the key stays the agent's: a key per worker would need an
administrator for every run on an external server); at its start it gets
only what its task needs: the memories its dependencies stored, read by id
with who stored them, and what memory holds about the task within a token
budget; when it is done, a checkpoint of the task under its name. The ids a
task stored travel to the tasks after it through the run's events
(`AttemptContext.note`, `TaskInput.memories`). 3 unit tests, and
`npm run eval:orchestration` (in CI) on a real Grafeno in memory: a
decision from the architecture worker reaches the two workers after it,
which store facts at the same time; the docs worker gets both; attribution,
checkpoints, the palace, and no operational state in memory, checked in
Grafeno.

**A7 done** (`verify.ts`, `policy.ts`): the verifier checks a task's
acceptance by code in its worktree (each command must exit 0 and be
allowed; each file must exist inside the worktree; a review is never the
only evidence), with a `CommandRunner` interface (the default `shellRunner`
runs with the user's rights: not a sandbox) and a trimmed, redacted
diagnostic. A failed check makes the attempt a retry whose diagnostic
reaches the same worker as `previous`, in the same worktree, so it fixes
rather than restarts; `maxAttempts` bounds the loop. The policy engine
decides in code: `supervised` asks for every change and command,
`controlled` (default) allows writing in the task's worktree and a list of
checks and builds (tests, typecheck, lint, build, alone), `extended` allows
commands in the worktree; pushing, publishing, deploying, infrastructure,
other computers, deleting folders and throwing work away ask in every
mode; what a tool forbids stays forbidden. It is each worker's approver
(`WorkerPool.approverFor`) and the pipeline asks it before merging; without
a person to ask, the call is refused (or the task waits in review) and the
question is recorded. 11 tests, including the fix loop and supervised
merging on a real repository.

**A8 done** (`workers.ts` rounds, `memory.ts` progress, `telemetry.ts`): a
worker works in rounds of steps (`ContextPolicy.roundSteps`, default 40, at
most `maxRounds`, default 3). Between rounds, never in the middle of a tool
call, its context (as the provider reports it, or against an assumed
window, flagged as an estimate) decides: under 60 % it goes on in the same
session; from 60 % a warning is recorded; from 80 % it writes its progress,
which is saved as a checkpoint in Grafeno, and a fresh session continues
from the task, that progress and the list of files changed (from git, to
be read rather than trusted from a summary), not the old conversation. A
per-attempt token budget can be set (`attemptTokens`). Every attempt
records its metrics (model, effort, tier, time, rounds, renewals, reported
tokens, context peak and window), with no text of the work; `runReport`
sums them per task and per model and effort, for the interface and for
phase C. 5 tests. Not done: recognising tasks a tool could settle without a
model (no safe rule yet; the planner is told to keep checks as acceptance).

**A9 done** (`orchestrator.ts`, `app/orchestrate.ts`, `tui/run-view.tsx`):

- **The orchestrator** wires the planner, the store, the scheduler, the
  pipeline, the workers, memory and the policy.
- **In the interface,** `/orchestrate <request>` shows the plan, runs it
  after the user agrees, and opens a run view: the DAG's states, the
  active workers, questions answered in place, and the report.
- **From the command line,** `grafeno-agent run "<request>"`
  (`--mode`, `--workers`, `--light`, `--yes`), `grafeno-agent runs [id]`
  and `grafeno-agent resume <id>`.

The first real runs, with three Claude workers (D5), are recorded in
[`docs/measurements/orchestration-2026-11-15.md`](measurements/orchestration-2026-11-15.md).
The first run failed, and so found two bugs that fake-model tests had not
shown:

1. A dependant's worktree started from the base commit, so it did not see
   its dependencies' work. It now starts from the integration branch's
   tip.
2. In `controlled`, workers could not run their own acceptance commands.
   They now may, exactly as written.

Both have tests that fail without the fix. The second run completed: three
tasks, one attempt each, 8 of 8 tests passing on the integration branch,
and the user's branch untouched.

**Phase A is done**, as far as the stage table below shows. Each stage's
"done when" is shown by tests (`npm run ci`, `eval`, `eval:agents`,
`eval:orchestration`), and one real run is recorded. The brief's own §A.10
list was not at hand when this was checked; it should be read against it.

| Stage | What                                                                                                                          | Done when (verified by tests)                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1    | Plan schema, checker (cycles, references, acceptance), planner prompt and repair loop                                         | Valid plans accepted; cyclic, dangling, unchecked plans refused with reasons; planner repairs from the problems (fake model)                      |
| A2    | Operational store and state machine                                                                                           | Every allowed transition works, every other is refused; state survives a new process                                                              |
| A3    | Scheduler: ready set, parallelism, `touches` locks, timeouts, retries, cancel, pause/resume, blocked propagation              | Scripted DAGs run in the right order with the right parallelism; failure blocks dependants; resume after a kill continues without redoing effects |
| A4    | Worker manager on `Agent` + `Provider`; profiles; router (rules + availability + fallback)                                    | Three fake workers in parallel with different tiers/efforts; a missing tier falls back as configured                                              |
| A5    | Worktrees: create, bind to task, commit, merge into the integration branch, conflict detection, safe cleanup                  | Two tasks changing different files merge; the same file conflicts and goes to review; the user's tree is untouched                                |
| A6    | Memory: per-worker names, task context, decisions shared by id, per-task checkpoints                                          | A decision stored by the architecture worker reaches the backend worker; attribution checked in Grafeno (in memory)                               |
| A7    | Verifier and fix loop; policy engine (`supervised`/`controlled`/`extended`)                                                   | A failing check returns to the worker, bounded; a forbidden action is refused in every mode; an ask waits for the user                            |
| A8    | Context lifecycle and budget; telemetry                                                                                       | Renewal at the threshold keeps the task going from a checkpoint; events recorded without secrets                                                  |
| A9    | Interface and CLI: `/orchestrate <request>`, run view (DAG, workers, states, questions), `grafeno-agent runs`; first real run | One message runs a small project end to end with three real Claude workers (D5)                                                                   |

Phase A is done when the acceptance list of the brief (§A.10) is shown by
tests and one real run, recorded in `docs/measurements/`.

### Phase B — several providers (building, from 2026-11-15)

The provider interface grows into a capability registry: per provider and
model, verified when possible (`status()`, a harmless call), cached with a
date: code, tools, background, streaming, efforts, resume, usage report,
signed in, available, context window, non-interactive mode. Adapters for
Codex CLI, Gemini CLI and others only through their official CLIs and
sign-ins. Fallbacks: find the cause, choose a compatible model, check
policy and quota, keep the checkpoint, reassign only tasks with no
recorded effect in flight.

**Decided with the user (2026-11-15):**

- **Second provider:** Codex CLI (`@openai/codex`, OpenAI's official
  CLI) with the user's ChatGPT subscription.
- **No pay-per-token billing, for any provider:** only official CLIs with
  their own sign-in, subscriptions, free quotas or local models; no paid
  API keys.
- **Scope:** the full phase.
- **Real runs:** small real runs on the second provider's quota are
  allowed.

**What Codex offers, checked on this computer (codex-cli 0.169.0, ChatGPT
Plus), without spending:**

- `codex login status` says how it is signed in.
- `codex debug models` lists the models, each with its efforts.
- The official `app-server` protocol's `account/rateLimits/read` gives
  the plan's windows: 5 hours and a week, as a share used and a reset
  time. The agent never consumes a "reset credit".
- `codex exec --json` streams JSON events: `thread.started`,
  `item.started` / `item.completed`, with items `agent_message` and
  `mcp_tool_call`, and `turn.completed` with token usage.

**Codex as the brain only,** like Claude:

- **Its own tools:** its shell, image viewer and web search are turned
  off. Its file patches cannot be turned off, so it runs with
  `--sandbox read-only` in a private temporary folder, where a patch is
  rejected. In a probe, it called the agent's MCP tool, and its attempt to
  write a file was refused by the sandbox.
- **The agent's tools:** they reach Codex as an MCP server
  (`mcp_servers.agent.url`), with the secret passed in an environment
  variable (`bearer_token_env_var`), never on the command line.

**Tiers on Codex:** deep `gpt-6-astra`; standard `gpt-6.1-sol`, then
`gpt-6.1-terra`; light `gpt-6-luna`. As with Claude, these are mapped by
the provider and never named elsewhere.

| Stage | What                                                                                                                                   | Done when (verified by tests)                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| B1    | Codex model adapter: `codex exec --json`, conversations by `exec resume`, the agent's tools over MCP, read-only sandbox, errors mapped | The model contract passes on a stand-in `codex`; a patch never reaches the disk; usage limit, sign-in and lost conversation mapped |
| B2    | Codex provider: status, models with efforts, real usage from the app-server, tiers                                                     | Parsed from recorded outputs; on the real CLI, without spending: signed in, models and windows read                                |
| B3    | Capability registry: per provider and model, verified when possible, cached with its date in the data folder                           | Capabilities read, cached, refreshed when old or when a provider changes version; a provider not installed or signed out is marked |
| B4    | Routing across providers: the router picks a provider and model per task from the registry, the profiles and real usage                | Tasks go to the provider set for them, else the preferred one with room; near a limit, to another provider before a lighter tier   |
| B5    | Fallback: a failure's cause, a compatible model elsewhere, policy and quota checked, the checkpoint kept, only safe reassignment       | A provider at its limit or signed out moves its next attempts elsewhere; a task with an effect in flight is never reassigned       |
| B6    | Interface and a real mixed run: `/connect` and `/models` across providers, `/usage` for each, `AGENT_PROVIDERS`                        | One run uses Claude and Codex workers together, recorded in `docs/measurements/`                                                   |

Phase B is done when every stage's "done when" is shown by tests and the
mixed run is recorded.

**Progress (2026-11-15):** B1–B5 are done, and B6 is mostly done.

- **B1** (`src/model/codex.ts`): 21 tests on a stand-in `codex`, and the
  model contract 4/4 on real Codex.
- **B2** (`src/providers/codex.ts`): 17 tests; on the real CLI, without
  spending, it reads the sign-in (ChatGPT Plus), 8 models with their
  efforts, and the windows.
- **B3** (`src/providers/registry.ts`): 5 tests.
- **B4** (`routeAcross` in `router.ts`).
- **B5** (`WorkerPool` with several providers, the scheduler's `moved`
  outcome, `store.effectsInFlight`): 9 tests, including a run where the
  first provider hits its limit midway and the second finishes it.
- **B6:**
  - **Done:** `AGENT_PROVIDERS`, `--providers`, `--provider-for`;
    `/connect` lists every provider and `/usage` shows each chosen one.
  - **The real runs** are in
    [`docs/measurements/providers-2026-11-15.md`](measurements/providers-2026-11-15.md).
    The first found that Codex would not write through the agent's tools,
    which is fixed. The second completed on Codex, routed there by
    Claude's real usage (86 %).
  - **Left:** a run where Claude and Codex workers both finish their
    tasks, once Claude's window has room.

#### B7 — "Auto" across providers (asked by the user, 2026-11-15; to build)

**What the user wants.** A session can work with one provider, or with
all of them:

- **One provider, model Auto:** the provider's own automatic choice of its
  models, with no orchestration. Claude Code has it ("Default"); Codex
  does when no model is given, but `/models` does not offer it yet.
- **General Auto:** every task of the session is orchestrated across all
  connected providers (installed, signed in with their subscription, with
  quota left), in the same session. One model plans; then workers are
  created and tasks are shared among the models of every provider, by
  their role. The user's example:
  - Sonnet 5.5, medium, plans;
  - GPT-5.6 Luna, low, writes a ROADMAP .md;
  - GPT-5.6 Sol, medium, makes an analysis;
  - Opus 5.5, medium, reviews the code;
  - Gemini Flash-Lite helps Luna document, once a Gemini CLI adapter
    exists.

**How it works today.**

- **The chat:** one provider, the first of `AGENT_PROVIDERS`.
- **Orchestration:** a separate command (`/orchestrate`, `run`). The
  planner is always the first provider.
- **Sharing tasks:** a task goes to the provider set for its kind, else to
  the first with room. With room everywhere, every task goes to the first
  provider. Providers mix only near a limit.
- **Not built:** help between workers, and Gemini.

**Proposed design (B7):**

1. **Two choices in a session:** a provider (Claude, Codex… or **Auto**)
   and a model (a named one, or **Auto**). A named provider with model
   Auto uses that provider's own choice. Provider Auto orchestrates across
   all of them.
2. **A cheap triage in General Auto:** a light model decides, for each
   message, between a direct answer (one worker) and orchestration. A
   question then never starts five agents.
3. **A pool of models:** for each task, the candidates are every ready
   provider's models of the task's tier, chosen by an explicit, logged
   rule:
   1. the tier the complexity needs;
   2. an affinity per task kind, which the user can set (for example
      review → a deep model, docs → a light one);
   3. each plan's headroom;
   4. spreading, so one plan is not always the one spent.

   This is the rule-based form of phase C's learning router.

4. **The planner from the same pool,** as an architecture task: the best
   deep model with room.
5. **Help between workers** ("Gemini helps Luna") is phase D.4 (cross
   review). In B7, only review tasks with checks by code.
6. **Gemini CLI** is a later adapter like Codex's: its official CLI and
   the user's own Google sign-in, once installed.

**Decided by the user (2026-11-15):**

- **Triage, not always orchestrate:** in General Auto a light model
  decides, for each message, between a direct answer and orchestration;
  orchestrating every message would spend quota on trivial ones.
- **Affinity by role first:** each task kind goes to its preferred model
  (user-configurable); spreading across plans is only the tie-break, and
  each plan's quota is always a hard limit.

**Decided by the user (2026-11-15, later):**

- **Default affinities, as in the user's example:**
  - planning and architecture → Claude, standard;
  - review → Claude, deep;
  - backend and debug → Claude, deep;
  - docs → Codex, light;
  - tests and refactor → Codex, standard;
  - frontend → whichever has more room.

  A setting changes them.

- **The B6 run comes at the end of B7:** one small run that also checks
  General Auto, with the user's OK just before it, once both windows have
  room.

**B7 progress (2026-11-15):**

- **B7a, the pool (done):**
  - `routeAcross` with `auto`: the rule above, each step logged. First the
    tier (the planner's recommendation, else the affinity's tier, else the
    profile; a hard task never below standard). Then the affinity, with an
    explicit `--provider-for` before it. Then headroom: a plan at its limit
    is never used, and one near it only when no plan has room. Spreading is
    the tie-break: the most room, then the fewest tasks given so far in the
    run, then the order.
  - `DEFAULT_AFFINITY` holds the user's example. `AGENT_AFFINITY` changes it
    (`kind=provider[:tier]`, or `kind=none`).
  - `AGENT_PROVIDERS=auto` and `--providers auto` mean every known
    provider; the registry keeps the ready ones.
  - **The planner from the same pool, on its own provider.** This fixes a
    bug: the planner's route was taken from the pool, but its model was
    always made with the first provider. The plan view says who planned and
    routes the tasks in order, counting what each provider was given, as
    the run will.
  - Tests: `test/orchestrator/auto.test.ts`, 11 tests. They cover the
    user's example, most room, spreading, an affinity with no room or not
    ready, the hard limit, the order of `--provider-for` and the
    recommendation, mode off, the settings, and a whole run where Claude
    plans and both providers finish their tasks. Full CI: 392.
- **B7b, a provider and its model Auto (done):**
  - `/models` starts with "Auto" for every provider. For Claude it is
    Claude Code's own choice, and the hint says what that is now (for
    example Opus 5.5). For Codex, no model is given (no `-m`), so Codex
    chooses. On the real CLIs, without spending: Codex lists Auto and its 8
    models.
  - `/connect` now chooses the provider the chat uses: Enter on a ready
    provider (installed and signed in) switches the session to it
    (`AgentSession.setProvider`). The conversation goes on with it, given
    as data. The model and effort start as Auto, since another provider's
    model ids mean nothing to it.
  - The choice is saved: `AGENT_PROVIDERS` with that provider first, and
    the previous model and effort cleared. The panel marks the provider in
    use.
  - Tests: the model lists of both providers, and a terminal test where
    `/connect` moves a conversation from one provider to another, which
    answers with the conversation behind it. Full CI: 393.
  - The "Auto" provider in `/connect` comes with B7c, which gives it
    meaning: triage.
- **B7c, General Auto in the session (done):**
  - `/connect` offers "Auto" after the providers. Choosing it turns General
    Auto on: saved as `AGENT_PROVIDERS=auto`, with the chat on the ready
    provider that has the most room. Choosing a named provider turns it
    off.
  - **Triage** (`src/app/triage.ts`): before each message, a light model
    is asked one line, DIRECT or ORCHESTRATE, with a reason. It is the
    lightest model, low effort and no tools, of the ready provider with the
    most room. It is read strictly: anything unclear, and any failure, is a
    direct answer, the cheap way. The decision and the model that took it
    are shown.
  - **Direct:** the chat answers. If its provider has no room (80% or
    more) or is not ready, the chat moves to the one with the most room.
  - **Orchestrate:** the request is planned with General Auto (B7a). The
    planner comes from the pool, the tasks go by affinity, and the plan is
    shown to run, as with `/orchestrate`. `/orchestrate` itself also uses
    the pool while Auto is on.
  - The ready providers and their usage are read at most once a minute.
    Read on this computer, without spending: Claude Pro at 79% of its five
    hours (this session), Codex Plus at 1%. The pool chooses Codex.
  - Tests: `test/app/triage.test.ts` (6) and a terminal test: Auto on from
    `/connect`, a question answered directly, and a build request planned
    across providers. Full CI: 400.

- **The README (done):** a "Several providers" section (Codex setup,
  `/connect` and Auto, `--providers`, `--provider-for`, `AGENT_AFFINITY`,
  the default affinities), the new settings, and the memory changes
  (compact resume, budgets, revise, renewal, `resume --compact`).

**What is left of phase B, in order:**

1. B6: one real run where Claude and Codex workers both finish their
   tasks, in General Auto, with the user's OK, once Claude's five-hour
   window has room (79% when B7 was finished).
2. Then phase B is checked against the brief's §B.1–B.4 and closed.

**Still open from phase A:** a container `CommandRunner` for real
isolation of untrusted commands (§A.9).

### Phase C — the router learns (design only now)

Per attempt, already in telemetry: kind, complexity, tier, model id,
effort, duration, tokens, retries, fixes, checks, review, failure reason.
First a rule table; then simple statistics (success rate and cost per kind
and tier, with a minimum sample and comparable tasks only). A learned rule
replaces a fixed one only when it beats it on recorded runs.

### Phase D — long autonomous runs (design only now)

Replanning of the affected part of the DAG only; a supervisor process for
runs that outlive the terminal (status, pause, resume, cancel, recovery
after reboot, notifications); recovery from worker crash, timeout,
provider failure, quota exhausted (wait until reset, never work around),
git conflicts, failed checks, Grafeno unreachable; cross review as extra
evidence; integration under the policy; global and per-worker limits.

## 5. Risks and limits

- **Quota.** Parallel workers spend the plan faster. The router reads the
  real usage and holds work near the limit; the user sets `maxWorkers`.
- **Not a sandbox** until D2 (b): commands run with the user's rights in
  the worktree.
- **Windows**: long worktree paths; the data folder keeps them short.
  Several `claude` processes and MCP servers at once: ports and memory to
  be measured in A4.
- **Planner quality**: plans are only as good as the model; the checker
  catches structure, not wisdom. Acceptance by real commands is what keeps
  quality honest.
- **Grafeno**: `context` is not scoped to a palace yet (GRAFENO_FIX #1), so
  workers of one project can see another's memories in the same
  namespace; use a namespace per project until it is fixed.
- **`node:sqlite`** is experimental in Node 22 (D1).
