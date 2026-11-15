# Grafeno Agent — roadmap

An agent with long-term memory, built on Grafeno. Grafeno keeps what the
agent knows; the agent brings the reasoning (a language model), the loop
that decides what to do, and its own tools.

## Principles

- **Grafeno stays independent.** The agent depends on Grafeno, through its
  published interfaces (the TypeScript client `@grafenodb/client`, the
  HTTP tools, MCP). Grafeno never depends on the agent, a model or a
  provider. Something the agent needs from Grafeno goes into Grafeno as a
  general feature, in Grafeno's own repository.
- **The model can be swapped.** No part of the agent outside the model layer
  knows which model or provider runs it.
- **Memory is a policy.** What to store, when to look it up and when to
  doubt it is designed and measured, not left to chance.
- **No secrets in memory.** Keys, passwords and tokens are never stored.
- **Nothing irreversible without authorization.** Tools that write outside
  the agent's memory ask first.
- **A phase is done when its tests run and pass**, not when its code is
  written.

## Phase 0 — Decisions and foundations

Decide, with the user:

- what the agent is for (programming, personal assistant, a domain);
- which model it uses first (a provider over an API, or a local model);
- where it is used first (a command line, a web chat, an application).

**Decided (2026-11-14):**

- **Purpose:** a programming assistant.
- **First model:** Claude through the user's Claude Pro subscription, with
  no API key and no pay-per-token billing. The first adapter drives the
  locally logged-in Claude Code (headless `claude -p` with streamed JSON,
  or the Claude Agent SDK on the same login, if its terms allow it). The
  subscription is used transparently, within Anthropic's terms and the
  plan's own usage limits: the agent never tries to get more usage than
  the plan gives, and never extracts or reuses Claude Code's credentials
  in other clients. The model interface keeps other adapters possible,
  but none that bills per token is used unless the user decides so.

**How the subscription is used (decided 2026-11-14):**

- **Like Herdr:** the agent starts the official, unmodified `claude`
  binary as the user, under the login the user made in Claude Code
  itself. The agent never reads, stores or passes on Claude's
  credentials, and offers no Claude login of its own. Anthropic's terms
  allow a user to sign in to the unmodified binary with their own
  subscription; they forbid apps that intermediate credentials or route
  requests through a plan on behalf of others. For subscription use, the
  CLI is preferred over the Agent SDK, whose overview restricts
  claude.ai login in products built on it.
- **The same quota:** what the agent asks of Claude counts against the
  user's own Pro plan, exactly as if the user had asked it. When the plan's
  limit is reached, the agent stops cleanly and says so; it never works
  around the limit.
- **Claude as the brain only (option A):** `claude -p` with streamed JSON,
  no built-in tools (`--tools ""`), and only the agent's own MCP server
  (`--mcp-config` with `--strict-mcp-config`). The agent keeps its loop,
  its tools, its permissions and its Grafeno memory. `--bare` is not used:
  it does not read the subscription login.
- **Still open:** no official page says which usage pool `claude -p`
  draws from; a separate monthly "Agent SDK credit" was reported but not
  confirmed. Phase 1 measures it on the user's account before relying on
  it.
- **First interface:** the command line.

Then:

- the repository: git, TypeScript on Node ≥ 20 (in practice ≥ 22.18,
  which `@grafenodb/client` requires), tests, lint, formatting, CI,
  licenses;
- settings from the environment or a file: the Grafeno server's address,
  the agent's key, the namespace, the model; nothing secret in the
  repository;
- a check at start-up that Grafeno answers (`/health`) and that the key
  works (`GET /v1/{ns}/tools`).

**Done when** the repository builds, its tests run in CI and the agent
connects to a Grafeno server with its own key.

**Status (2026-11-14):** done locally. `npm run ci` passes; `npm run check`
and `npm run test:live` pass against the local Grafeno 0.3.0 with the
agent's own key in namespace `grafeno-agent`. The CI workflow is written
but has not run yet: there is no remote repository.

## Phase 1 — The model layer

- One interface for every model: messages, tool calls and their results,
  streaming, token counts, stop reasons.
- A first adapter for the model chosen in phase 0.
- A scripted fake model, so the rest can be tested without calling any
  model.
- Timeouts, retries with backoff, and clear errors.

**Done when** the same test suite passes against the fake model and,
optionally, the real one.

**Status (2026-11-14):** done. The interface (`src/model/types.ts`) is
turn-based: a model holds conversations, and calls the agent's tools
through a `ToolHost` the agent controls, so the same contract fits a
model run by another program (Claude Code) and one called directly. The
first adapter, `claude-code`, starts `claude -p` with streamed JSON, no
built-in tools, and the agent's tools over a local MCP server; it reads
the plan's usage windows and stops on the usage limit. `resilient()` adds
a time limit per turn and retries with backoff, only before anything of
the turn was seen, so no tool runs twice. The model contract passes on
`FakeModel` and on real Claude (Haiku); the adapter's own tests run
against a stand-in `claude` and spend no plan usage. Measured: `claude -p`
reports the plan's own five-hour and seven-day windows, so it draws on
the same subscription usage. Known limit: cancelling a turn stops Claude
Code, and the conversation with it.

## Phase 2 — The agent loop

- A turn: read the input, ask the model, run the tools it calls, give
  back their results, repeat until it answers.
- A tool registry: name, description, argument schema, whether it writes.
- Limits: steps per turn, time, tokens; cancelling a turn.
- A first interface (the one chosen in phase 0) to talk to it.

**Done when** the agent holds a conversation and uses a trivial tool, with
tests on the fake model for the loop's limits and errors.

**Status (2026-11-14):** done. `Agent` runs turns over the model
interface: steps per turn (default 20), time per turn (from
`resilient`), a token budget per session, cancelling, and starting the
conversation again when the model lost it (it says so). `ToolRegistry` is
the model's `ToolHost`: name, description, argument schema (checked before
anything runs), and `writes`; a writing tool runs only when the user
allows that call, and never when nobody can be asked. The command line
(`grafeno-agent chat`, the default) streams the answer, shows each tool
call, warns when a plan window is 80% used, asks before writing tools, and
has `/usage`, `/help` and `/exit`; Ctrl+C cancels the answer. The trivial
tool is `current_time`. Tested on the fake model, and tried by hand on
real Claude (Haiku). A token limit inside one turn is not enforced: Claude
Code reports usage only when the turn ends.

## Phase 3 — Memory with Grafeno

- The memory tools reach the model through `@grafenodb/client`
  (`tool()`): `context`, `recall`, `remember`, `relate`, `checkpoint`,
  `resume`, `palace_*`, `timeline`.
- Start of a session: `palace_map`, `palace_enter` the right room,
  `resume` the open task.
- Before answering what may depend on the past: `context`.
- After a turn: store decisions, facts and preferences (`remember`),
  connect them (`relate`), anchor them in their room (`palace_anchor`).
- End of a session: `checkpoint` with what was done and what is next.
- A filter that keeps secrets out of what is stored.

**Done when** a second session picks up what the first left without being
told, with tests that check what was stored and recalled.

**Status (2026-11-14):** done. `MemorySession` (`src/memory/session.ts`)
holds the policy. Each project (the git repository the agent runs in, or
`AGENT_PROJECT`) has a palace of its name, a room `General` (loci
Decisions, Facts, Preferences, Open questions, Notes) and a `Project`
node. At start, the agent enters the room and resumes the project's
latest checkpoint, and both go into the system prompt. Before each
message, `context` puts what memory knows in front of it, between
`<memory>` tags, as data. The model gets the memory tools (context,
recall, remember, relate, get_node, timeline, checkpoint, resume,
palace_map, palace_enter, palace_walk, palace_anchor, palace_create_room)
in the agent's namespace only; what it remembers is anchored in the room
by kind. Checkpoints are always about the project (on real Claude, the
model passed the room's id instead, and the next session missed the
checkpoint). On leaving after talking, one last turn saves a checkpoint.
A secret filter refuses to store keys, tokens, passwords and the agent's
own key. Tested with a fake memory, with real Grafeno and the fake model
across two sessions, and by hand on real Claude across two sessions.
Known: Claude Code tells the model its working folder (a private temp
folder), not the project's; the project's tools come in phase 6.

## Phase 4 — The quality of memory

- Before storing, look for the same thing (`find_matches`, `recall`) to
  avoid duplicates.
- `feedback` on what helped or misled; `forget` with `invalidate` for what
  stopped being true.
- `palace_reflect` when unsure: verified facts, claims and inferences kept
  apart; what is not known said as such.
- Upkeep on a schedule: `maintain`, `consolidate`, `palace_review`, with
  changes to the palace's arrangement only when the agent can say why.

**Done when** a long scripted run leaves no duplicates, no contradiction
unflagged, and a palace the review finds nothing to fix in.

**Status (2026-11-14):** done. Before `remember`, the agent recalls and
compares words (`src/memory/quality.ts`): what memory already holds is not
stored again, and the model is told which memory holds it (a memory of
the same name is Grafeno's own update, and goes through). Each memory is
linked to the project (`part_of`), so the room hangs together. The model
gets `feedback`, `forget` (facts only, `invalidate` or `retract`; memories
are never deleted: what stopped being true is marked `obsolete` and
related with `supersedes`), `palace_reflect`, `find_matches`, `update` and
`contradictions`, with the policy in its prompt. Loci are made when first
used, so none sits empty. `grafeno-agent upkeep` reads Grafeno's
`maintain`, `palace_review` and `contradictions`; it reports everything,
and with `--apply` carries out only the safe fix with a reason (linking a
loose room's memories to the project); merging, archiving what may be
superseded, consolidating and moving between rooms are left to judgment. A
check that cannot run is reported, never taken as clean. The chat suggests
upkeep when it has not run for 7 days (recorded on the project's node).
The long scripted run (three sessions, ten facts, three repeated, one
changed, a secret) passes against real Grafeno; on real Claude the model
followed the change policy by itself. Found: Grafeno's `maintain` does not
flag two memories of identical words without embeddings; that belongs in
Grafeno, and phase 5 measures meaning.

## Phase 5 — Meaning (embeddings, optional)

- An embedder interface, with a local model or a provider behind it; the
  vectors go to Grafeno with each memory and each question.
- A vector index in the agent's namespace.
- Measure what meaning adds over words and the graph alone before keeping
  it.

**Done when** recall improves on a measured set of questions, or the phase
is closed with the measurement that shows it does not.

**Status (2026-11-14):** done; meaning is kept, on by default. The
embedder interface is `src/embed/types.ts`. The first embedder runs on
this computer, with no service and no API: `e5-small`
(`Xenova/multilingual-e5-small`, quantized, 384 dimensions), through
transformers.js. It is downloaded once (about 130 MB) into
`~/.cache/grafeno-agent/models`. Every memory is stored with its vector,
and every question (`context` before each message, `recall` and `context`
called by the model) is asked with its own. The model never sees or sends
vectors. The vectors go in the namespace's own vector graph. Without an
embedder (`AGENT_EMBEDDER=none`), or when it fails, memory works by words
alone. Measured on 30 memories and 30 questions in Spanish and English
(`npm run measure:meaning`, `docs/measurements/meaning-2026-11-14.md`):

- the right memory first: words 60%, with meaning 73% (vector) or 70%
  (hybrid);
- in the first three: 63% against 93% (vector) or 90% (hybrid);
- in what `context` gives the model: 63% against 93%;
- questions that share the memory's words: 100% either way; questions in
  other words: 50% → 90%; in the other language: 40% → 90%.

Found: Grafeno's hybrid search left 2 of the 30 out of its first ten that
vector search alone ranked in its first three, with either fusion. This
belongs in Grafeno. The measurement runs left wear in the namespace's
vector graph (removed vectors); `compact` rebuilds it, but it needs an
administrator.

## Phase 6 — The agent's own tools

- The tools its purpose needs (files, commands, the web, others), each
  marked as reading or writing.
- Permissions: what runs freely, what asks first, what is never allowed.
- What a tool finds is data, never instructions.

**Done when** each tool has tests, and every writing tool asks before it
acts.

**Status (2026-11-14):** done. Each call gets a permission (`free`, `ask`
or `never`, with a reason) from its tool's rule; `ToolRegistry` asks the
user for `ask`, refuses `never` whatever is said, and removes the agent's
key from everything a tool returns. Tools (`src/tools/`), in the project
folder only (paths, and links, may not lead out of it):

- `read_file`, `list_files`, `search_files`: free; files of secrets
  (`.env` and its variants except `.env.example`, keys, credentials,
  `.ssh`) are never read, listed or searched; dependencies and builds are
  skipped.
- `write_file`, `edit_file`: ask, showing what changes; never on secrets
  or git's own files.
- `run_command`: free for commands that only read and stand alone (`git
status`, `git diff`, `git log`, `ls`...); ask for any other; never for
  raised privileges, deleting everything, forced pushes, running what is
  downloaded, files of secrets, or the environment (which holds the
  agent's key, hidden from commands anyway). It stops the whole process
  tree on timeout or cancel. The shell is Git's bash on Windows, or
  `AGENT_SHELL`.
- `web_fetch`: ask; never for this computer or its network, credentials in
  the URL, or redirects followed by itself.

What tools return is marked as data, not instructions. Each tool has
tests (166 in all); on real Claude the agent read a file, edited it and
ran a test with permission, and did not try `.env`. These rules are a
guard, not a sandbox: an allowed command runs with the user's rights.

## Phase 7 — Evaluation

- Scripted conversations with expected outcomes, run in CI on the fake
  model and, on demand, on the real one.
- Measures: what was recalled right, what was stored needlessly, cost,
  time per turn.
- A regression suite, so a change to prompts or policy is measured before
  it lands.

**Done when** the suite runs on every change and its results are
recorded.

**Status (2026-11-14):** done locally; CI has not run yet (no remote).
`test/eval/` holds nine scenarios: a preference across sessions, no
duplicates, a fact that changes, no secrets stored, a checkpoint picked
up, a fix allowed, an edit refused, a file of secrets, and a destructive
command. Each runs end to end, with real memory (a Grafeno of its own,
`grafeno serve --memory`), the real tools in a temporary project, and the
fake model (`npm run eval`, no plan usage) or Claude (`npm run eval:real`,
Haiku by default). The suite measures:

- recall: what memory had to give the model, and did;
- needless memories: stored beyond what each scenario allows;
- duplicates refused;
- tokens (input, cache, output);
- time per turn;
- per scenario, its expectations: what was stored, files changed or not,
  secrets never stored or shown, and Grafeno's palace review finding
  nothing to fix.

Results go to `docs/eval/` (the latest per model, and a line per run in
`history.md`). The run fails below `test/eval/baseline.json`, and on the
fake model whenever a scenario fails. CI downloads the pinned Grafeno
release (checked by sha256), runs `npm run eval` on every change, and
keeps the results as an artifact.

Checked by breaking things on purpose. Turning off each guard in turn
(duplicates, secret filter, `.env` refusal, `rm -rf` refusal) made its
scenario fail. Two scenarios were too weak at first and were fixed:
`no-secrets` did not check what was stored, and `rm -rf .` is refused by
bash itself, so the scenario now uses `rm -rf *`. First results: 9/9 on
the fake model, and 9/9 on Claude Haiku, with recall 100% and nothing
needless (about 6 s a turn).

## Phase 8 — Interfaces and distribution

- The interfaces after the first one (command line, web chat, another
  application).
- Packaging and versions, with releases only after a green pipeline.
- Documentation: how to set it up with a Grafeno server, its settings,
  its tools.

**Done when** someone else can install it and use it from its
documentation alone.

**Status (2026-11-14):** done locally. Nothing is published, and there is
no remote yet, by the user's choice.

Decided with the user:

- license `MIT OR Apache-2.0`;
- an npm package (`grafeno-agent`, with a `grafeno-agent` command), still
  `private` until the owner decides to publish;
- no second interface for now.

Done:

- **Settings:** they live in a file of the user's
  (`grafeno-agent init`; `%APPDATA%\grafeno-agent\config.env` on Windows,
  `~/.config/grafeno-agent/config.env` elsewhere, or
  `GRAFENO_AGENT_CONFIG`). The installed agent never reads the `.env` of
  the project it runs in. `version` and `init` were added.
- **Install size:** the meaning model's runtime is an optional dependency;
  the agent falls back to words without it. The full install is about
  500 MB.
- **Releases:** `CHANGELOG.md`, `RELEASING.md`, and a release workflow
  that publishes on a `v<version>` tag only after the whole pipeline is
  green, refusing a tag that does not match the package or a package still
  private.
- **Documentation:** the README is rewritten for a new user, with
  requirements, install, the key, settings, use, permissions, memory and
  troubleshooting.

Checked by following the README alone. The packed tarball was installed
into a temporary prefix, the settings were written with `init`, the key
was added, `check` passed while the project's own `.env` (with wrong
values on purpose) was ignored, and a chat turn on Claude listed the
project's files. Not checked: `npm install -g` from the registry (nothing
is published), and CI (no remote).

## Phase 9 — Several agents

- One key per agent, its writes recorded under its name.
- Shared palaces where agents work together; palaces of their own where
  they do not.
- Watching all of them from Grafeno Studio.

**Done when** two agents work on one task at the same time without
undoing each other's memory.

**Status (2026-11-14):** done, on the fake model (also in CI) and live with
two agents on Claude Haiku against the owner's Grafeno server.

Decided with the user:

- an agent's name is its Grafeno key's name, read with `GET /v1/whoami`
  (no setting of its own); the convention is `grafeno-agent-<role>`;
- one key per agent, `--grant grafeno-agent:write --own-only`: it reads
  and adds to all the memory, and changes only what it recorded;
- the project's palace is shared by default; `AGENT_PALACE=own` gives an
  agent a palace of its own, `<project> · <agent>`, in the same namespace.

Done:

- **Identity:** `checkGrafeno` reads the key's name; `check` and the chat
  show it. Grafeno records it as `recorded_by` on every node and fact.
- **The project's node is shared:** it is looked up before it is made, and
  when another agent makes it at the same moment, theirs is used (an
  `--own-only` key may not "update" another's node by remembering its
  name).
- **Each agent's own marks:** a node per agent (`Agent`, `works_on` the
  project) holds when it last ran upkeep, which it may change.
- **Checkpoints:** saved under the agent's name, as the task
  `<project>: work of <agent>`. A session comes back to its own latest
  checkpoint, and is shown a newer one by another agent as that agent's.
- **Correcting another agent:** the model is told it may change only its
  own memories; a refusal, or a duplicate of another's memory, tells it to
  store the correction and relate it with `supersedes`.
- **Watching from Studio:** Studio already shows `recorded_by` on a node;
  the agent nodes make each agent visible in the graph.
- **The test:** `npm run eval:agents` (also in CI) runs three agents with
  `--own-only` keys on the fake model against Grafeno in memory: two
  start at the same moment and store 25 memories at once, all land under
  the right name; one tries to update, mark obsolete and forget the
  other's decision (all refused, the decision unchanged) and supersedes it
  instead; checkpoints stay each agent's own; a third agent's own palace
  stays apart. Mutation-checked: with keys that are not `--own-only`, five
  checks fail.

Found, for Grafeno itself:

- a memory superseded by another agent's still comes back in `context`
  (with the `supersedes` fact beside it): under `--own-only` the other
  agent cannot mark it obsolete, so `context`/`recall` could rank a memory
  with a current incoming `supersedes` lower, as a general feature.

Live run (2026-11-14): two `--own-only` keys, `grafeno-agent-dev` and
`grafeno-agent-review`, on Claude Haiku, two chats at once in a scratch
project. One project node (they started in the same second); 14 memories,
each under the agent that made it; review stored the new decision and
related it with `supersedes` to dev's, which stayed as dev left it, and
said on its own that it could not mark another agent's memory obsolete;
dev, asked afterwards, answered with review's decision; both saved their
checkpoints at the same moment and each gets its own back.

- Fixed from it: a room named without its palace failed when several
  palaces have one of that name (every project's palace has a "General");
  the session now retries with its own palace.
- Seen: models give checkpoints task names of their own, so the default
  `<project>: work of <agent>` is seldom used; `resume` filters by agent,
  so it does not matter.

Found in use (2026-11-14), for Grafeno itself: `context` searches the whole
namespace, so a project's session can be given another project's memories
(the live two-agent test project came back when asking about this one).
`context` and `recall` taking a `palace` to stay in (as `palace_walk` does,
but with meaning) would let each project's memory stay its own.

## Orchestration — phases A to D

The user's brief is [`docs/brief.md`](docs/brief.md); the design and each
stage's progress are in [`docs/orchestration.md`](docs/orchestration.md);
real runs are in [`docs/measurements/`](docs/measurements/).

| Phase | What                                                         | Status (2026-11-15)                                                    |
| ----- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A     | Several Claude Code workers under a deterministic scheduler  | **Done** (A1–A9), with one open item below                             |
| B     | Several providers: Codex CLI next to Claude Code             | **In progress**: B1–B5 done; B6 (interface, a real mixed run) underway |
| C     | A router that learns from real metrics                       | Design only; the metrics it needs are recorded since A8                |
| D     | Long autonomous runs: replanning, a supervisor, cross review | Design only                                                            |

### Phase A against the brief's acceptance list (§A.10)

| #   | Criterion                                             | Shown by                                                                                                             |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | One message asks for a complex task                   | `grafeno-agent run "<request>"`, `/orchestrate <request>`; the real runs of 2026-11-15                               |
| 2   | Claude makes a valid structured plan                  | Planner and checker (`plan.ts`, `planner.ts`, 10 tests); the real runs' plans                                        |
| 3   | The scheduler finds dependencies and parallelism      | `scheduler.ts` (13 tests); in the real run, tests and docs ran at once after the module                              |
| 4   | At least three independent Claude Code workers        | Three workers, each its own session, in the real run; three at once in `orchestrator.test.ts`                        |
| 5   | Different supported models or efforts                 | Real run: Sonnet low and Haiku low; tests: three tiers and efforts                                                   |
| 6   | File isolation per worker                             | A git worktree and branch per task (`worktrees.ts`, 11 tests on a real repository)                                   |
| 7   | Grafeno shares relevant knowledge between workers     | `npm run eval:orchestration` (a decision reaches the workers after it, with attribution), in CI                      |
| 8   | Checkpoints and operational states are recorded       | SQLite store with runs, tasks, events and effects; a Grafeno checkpoint per task                                     |
| 9   | Failures are detected and safe runs recovered         | Fix loop from failed checks, bounded retries, recovery of attempts a dead process left; the first real run's failure |
| 10  | Integration tests run                                 | Pipeline tests on real git, `eval:orchestration` on a real Grafeno, the real runs                                    |
| 11  | Changes integrate without overwriting the user's work | An integration branch per run; the user's branch, HEAD and uncommitted changes untouched (tested, and in real runs)  |
| 12  | Permissions and quotas are respected                  | The policy engine (11 tests); the provider's limit pauses the run without spending an attempt                        |
| 13  | An interrupted task can be continued                  | Resume from another process (tested); `grafeno-agent resume <id>`                                                    |
| 14  | Automated tests of the main components                | 335 tests in `npm run ci`, plus the evals                                                                            |

**Open item:** §A.9 asks for real isolation for untrusted commands ("string
checks are not a sandbox"). Phase A decided, with the user (D2 a), on
worktrees, the policy engine and the existing guard, documented as _not_ a
sandbox, behind a `CommandRunner` interface so that a container runner
(Docker or Podman) can be plugged in. That runner is still to be built.

**Smaller gaps:**

- Criterion 7 is shown on a real Grafeno with the fake model; in the small
  real runs, workers stored no memories of their own, only checkpoints.
- Criterion 13 is tested with the fake model; it has not yet been done on
  a real run.

### Phase B

The second provider is Codex CLI with the user's ChatGPT plan, decided on
2026-11-15. The brief's §B.5 had said Claude alone at first; the user
chose to go on. Stages B1–B6 are in `docs/orchestration.md`.

**Closed (2026-11-15).** Checked point by point against the brief's
§B.1–B.4 in `docs/orchestration.md`:

- B1–B5 and B7 ("Auto" across providers: one pool, affinity by role,
  triage per message) are shown by tests.
- B6, a real run where Claude and Codex workers both finished their
  tasks, is recorded in `docs/measurements/providers-2026-11-15.md`.

Two limits are written down:

- Codex does not say its context window, so its share is estimated.
- The adapters' features are declared and shown by the model contract on
  the real CLIs, not probed at run time (that would spend quota).

Gemini CLI and Grok are later adapters on the same interface.
