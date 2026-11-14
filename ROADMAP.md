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
  in other clients. Still to confirm in phase 1: the current terms for
  this use, and how the model's tool calls reach the agent's own tools.
  The model interface keeps other adapters possible, but none that bills
  per token is used unless the user decides so.
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

## Phase 2 — The agent loop

- A turn: read the input, ask the model, run the tools it calls, give
  back their results, repeat until it answers.
- A tool registry: name, description, argument schema, whether it writes.
- Limits: steps per turn, time, tokens; cancelling a turn.
- A first interface (the one chosen in phase 0) to talk to it.

**Done when** the agent holds a conversation and uses a trivial tool, with
tests on the fake model for the loop's limits and errors.

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

## Phase 5 — Meaning (embeddings, optional)

- An embedder interface, with a local model or a provider behind it; the
  vectors go to Grafeno with each memory and each question.
- A vector index in the agent's namespace.
- Measure what meaning adds over words and the graph alone before keeping
  it.

**Done when** recall improves on a measured set of questions, or the phase
is closed with the measurement that shows it does not.

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
