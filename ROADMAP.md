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

## Phase 7 — Evaluation

- Scripted conversations with expected outcomes, run in CI on the fake
  model and, on demand, on the real one.
- Measures: what was recalled right, what was stored needlessly, cost,
  time per turn.
- A regression suite, so a change to prompts or policy is measured before
  it lands.

**Done when** the suite runs on every change and its results are
recorded.

## Phase 8 — Interfaces and distribution

- The interfaces after the first one (command line, web chat, another
  application).
- Packaging and versions, with releases only after a green pipeline.
- Documentation: how to set it up with a Grafeno server, its settings,
  its tools.

**Done when** someone else can install it and use it from its
documentation alone.

## Phase 9 — Several agents

- One key per agent, its writes recorded under its name.
- Shared palaces where agents work together; palaces of their own where
  they do not.
- Watching all of them from Grafeno Studio.

**Done when** two agents work on one task at the same time without
undoing each other's memory.
