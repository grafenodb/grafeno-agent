# Memory retrieval and context use

Why a new session can spend a large share of a fresh Claude Code window, and
what to change. Stage 1 of the brief "Optimización de recuperación de memoria
y consumo de contexto": the audit and the baseline, measured before any
change.

## How it was measured

- **Claude Code transcripts** (`~/.claude/projects/<project>/*.jsonl`). Every
  model call there records its `usage`: input, cache read, cache write and
  output tokens. Tool results are recorded too, so each one's size is known.
  Four long sessions were read: two on this project and two on Grafeno.
- **Grafeno's tools, called directly** on the live server, with the same key
  and namespace that Claude Code's MCP connection uses. For each tool, the
  size of its answer and how long it took.
- **The code** of Grafeno Agent: `src/memory/session.ts`,
  `src/app/session.ts`, `src/sessions/store.ts` and
  `src/model/claude-code.ts`.

Sizes in tokens are estimates (characters ÷ 4), except where they come from
Claude's own `usage`. No figure here is a share of the plan's quota.
Anthropic does not publish how input, cache read, cache write and output
weigh in the 5-hour window, so tokens are not converted to percentages.

## Findings

### 1. The main cost: carrying a long conversation into a new window (measured)

When the 5-hour window runs out and the same Claude Code conversation goes on
later, the prompt cache has expired. Its time to live is far shorter than the
wait. The first call then writes the whole conversation into the cache again,
and every later call reads all of it.

| Session            | Wait    | Context of the first call | Cache write, that call | Next calls | Cache read in them | Output in them |
| ------------------ | ------- | ------------------------- | ---------------------- | ---------- | ------------------ | -------------- |
| 29455c0d, call 295 | 258 min | 570k                      | 524k                   | 15         | 8.1M               | 11k            |
| 29455c0d, call 511 | 205 min | 938k                      | 892k                   | 19         | 17.2M              | 9k             |
| 47bc8dfa, call 294 | 525 min | 626k                      | 581k                   | —          | —                  | —              |

After a pause, then, the window is spent on re-sending the conversation
(about 0.9M tokens per call), not on Grafeno: no memory tool was called in
those stretches. A fresh session starts at about 69k tokens: the Claude Code
prompt, tools and project instructions, measured on the first call of two
sessions (69,332 and 68,742).

### 2. Recovering from Grafeno at the start: small text, many round trips (measured)

From the start of a session to its first edit:

| Session                | Model calls | Grafeno calls | Grafeno results        | Cache read | Share of the session's cache read |
| ---------------------- | ----------- | ------------- | ---------------------- | ---------- | --------------------------------- |
| grafeno-agent 29455c0d | 32          | 4             | 13k chars (~3k tokens) | 3.18M      | 1.2%                              |
| grafeno-agent 47bc8dfa | 11          | 29            | 11k chars              | 1.04M      | 0.4%                              |
| grafeno 66dfc3e9       | 14          | 31            | 14k chars              | 0.65M      | — (short session)                 |
| grafeno 0d6ae4a6       | 7           | 0             | —                      | 0.55M      | 0.2%                              |

Grafeno's answers are small next to the ~69k prefix. What costs is each round
trip: every memory call is one more model call, and each re-reads the whole
prefix. Following `CLAUDE.local.md` (`palace_map`, `palace_enter`, `resume`,
then `recall` or `context`) takes four to six round trips before any work.
Reading files to check the state costs more than memory does. In 29455c0d,
Bash results before the first edit were 89k chars, against 13k from Grafeno.

The tools' answers, measured on the live server (palace "Grafeno Agent"):

| Call                                | Size         | Note                                                  |
| ----------------------------------- | ------------ | ----------------------------------------------------- |
| `tools/list` (36 tools)             | ~9.6k tokens | Deferred in Claude Code: loaded only when used        |
| `palace_map`                        | ~1.7k tokens | Pretty-printed JSON, with every room's and locus's id |
| `palace_enter` (room Orchestration) | ~1.5k tokens |                                                       |
| `recall` (default limit)            | ~2.2k tokens |                                                       |
| `context` (default budget)          | ~1.1k tokens | ~355 tokens with budget 600                           |
| `resume`                            | ~200 tokens  | The latest checkpoint                                 |

Every call took 4–10 ms. Latency is not the problem.

### 3. Grafeno Agent's own sessions (scenario A): already bounded (code)

- The start is deterministic and uses no model call. It runs
  `palace_create`, `palace_create_room`, `recall` (the project node),
  `palace_anchor`, `remember` + `relate` (the agent node), then
  `palace_enter` (budget 1500) and one or two `resume` calls, and puts the
  result into the system prompt.
- Before each message, `context` adds up to 600 tokens.
- Claude Code runs as one long-lived process (stream-json), with Grafeno
  Agent's own system prompt and no built-in tools. History is not rebuilt
  on each turn.
- `/resume` carries at most 8,000 characters of the saved conversation
  (`previousConversation`).
- Redundant work: about seven Grafeno calls on every start. Five of them only
  make sure that things exist (palace, room, project, agent node, anchor).
  They are cheap (milliseconds, no tokens), but no budget covers the brief:
  the checkpoint text is added on top of the 1500 tokens.
- Not measured or controlled: the total size of the brief, the window's
  utilization before and after (the adapter reads Claude Code's rate-limit
  windows but does not log them per phase), and how much of the recalled
  memory is actually used.

### 4. What Claude Code reports

`stream-json` gives `usage` for each call (input, output, cache read, cache
write) and rate-limit windows (`usage_windows`: utilization and reset
times). The adapter already reads both. Grafeno Agent can therefore measure
the change in the window's utilization around a resume, which this audit
could not. Claude Code's own internal history (scenario B) cannot be
trimmed from outside. The only options are to start a new session, or to
compact.

## Conclusion

The ~20% the user saw matches finding 1, not Grafeno. Taking up the same long
conversation after the window resets re-sends 0.5–0.9M tokens on the first
call and reads them again on every call after it. The Grafeno palace adds a
few thousand tokens and a handful of round trips. Both are worth cutting, but
they are second.

Therefore:

1. **Start a new session instead of taking up the old one**, with a compact
   resume. This is the biggest win, and Grafeno already holds what is needed
   to make it safe.
2. **Make the compact resume cost no model call**. In scenario B, a
   `SessionStart` hook prints the compact resume, so Claude starts with it
   without spending round trips on `palace_map` / `palace_enter` / `resume`.
   In scenario A it is already deterministic: give it a budget and a
   structure.
3. **Cut the round trips and oversized answers** at the start:
   `CLAUDE.local.md` should no longer require `palace_map` + `palace_enter`
   every time, and lookups should use explicit limits.
4. **Let Grafeno Agent rotate its own sessions** (scenario A). When the cache
   is cold and the conversation is large, it saves a checkpoint and starts
   fresh, instead of re-sending.

Any expected saving is an estimate until it is measured: about 69–75k tokens
of context per call in a fresh session, against 570–938k when the old
conversation goes on. Stage 5 must measure it, including the window's
utilization from `usage_windows`.

## Decided by the user (2026-11-14)

- **Scenario B gets its resume from a `SessionStart` hook.** The hook runs
  `grafeno-agent resume --compact` and adds the compact state before the
  first message. That costs no model call and needs no change in Grafeno.
- **Structured checkpoints use Grafeno's existing fields.** Grafeno Agent
  packs `errors`, `blocked`, `memory_refs` and `git_ref` into the current
  checkpoint (summary, done, next, decisions, files) in a fixed format that
  tests check. Grafeno is not changed.
- **Scenario A rotates on its own.** After a long pause, with a cold cache and
  a large conversation, Grafeno Agent saves a checkpoint and starts a new
  conversation with the compact resume, saying so in one line. It never cuts
  off a turn in progress.

## Stage 2: Compact Resume and structured checkpoints (done)

### What was built

- **`src/memory/checkpoint.ts`** writes and reads the structured checkpoint
  inside Grafeno's own fields. `next[0]` is the next action and the rest of
  `next` is pending. The summary ends with a single line,
  `state: {"v":1,...}`, holding the goal, the status
  (`in_progress | blocked | paused | done`), what is blocked, the open errors,
  `memory_refs` and the `git_ref`. Checkpoints saved before this format read
  without a state, with status `in_progress`.
- **`src/memory/resume.ts`** (`compactResume`) builds the state by code,
  with no model call:
  1. `resume` for the latest checkpoint. With an agent's name, it adds a
     second `resume`, and notes another agent's newer checkpoint in one line.
  2. One `recall` by the goal and the next action (`limit` 3 × max memories,
     `depth` 0). Checkpoints, the project and agent nodes, and anything that
     repeats the checkpoint or another result are left out.
  3. A budget for each part: about 500 tokens for the checkpoint, 500 for the
     memories, at most 5 memories. The task, the next action, what is blocked
     and the open errors are always included, each cut to a sensible length.
     The other lists are cut from the end, and the text says how many were
     left out. Memories past the budget, and refs the search did not find,
     are listed by id, to look up only when needed.
  4. Measures: Grafeno calls, ms, estimated tokens for each part, memories
     returned, left out and deduplicated, and checkpoint items cut.
     When Grafeno cannot be reached, the text says so and nothing fails. When
     the search fails, the checkpoint alone is enough to go on.
- **Scenario A** (`MemorySession.start`) builds its brief with
  `compactResume` instead of `palace_enter` (budget 1500) plus the full
  checkpoint text. The model's `checkpoint` tool gains `goal`, `status`,
  `next_action`, `blocked`, `errors` and `memory_refs`. The memories stored
  in the session (the last 10) and the repository's `git rev-parse --short
HEAD` are added on their own. The system prompt tells the model to go on
  from the next action and to look up more only when needed.
- **`grafeno-agent resume --compact`** prints the compact resume. It only
  reads: it creates nothing in memory and calls no model. Options:
  `--task`, `--project`, `--budget`, `--memory-budget`, `--max-memories`,
  `--json`. The measures go to stderr, so a hook does not put them into the
  context. It exits 0 even when Grafeno cannot be reached.

### Measured

On the live server, palace "Grafeno Agent", for the task in progress:

| Start                                                                                            | Memory text into context                        | Model round trips for it                  | Grafeno calls | Time         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------- | ------------- | ------------ |
| Before (scenario B, as `CLAUDE.local.md` asks: `palace_map`, `palace_enter`, `resume`, `recall`) | ~5.6k tokens (1,732 + 1,466 + 202 + 2,183)      | 4 or more (each re-reads the ~69k prefix) | 4             | 4–10 ms each |
| `resume --compact` by project                                                                    | ~788 tokens (checkpoint 271, memories 454, ids) | 0 with the hook                           | 3             | 43 ms        |
| `resume --compact --task …`                                                                      | ~788 tokens                                     | 0 with the hook                           | 2             | 36 ms        |

The memory text drops by about 86% (5.6k → 0.8k tokens), and the round
trips drop from four or more to none. Both are measured on the same palace
and the same task. That is the smaller part of the problem, though. The
large cost is still the one in finding 1: carrying a long conversation into
a new window. The compact resume is what makes the cheap way safe: start a
new session and let the hook bring the state.

How good the resume is was checked by hand on this task. It had the task,
the next action, the pending stages, the decisions, the files and the user's
decisions on this work. Some of the related memories were less relevant
(older phases of the project). Stage 3 tunes the ranking.

Tests: `test/memory/checkpoint.test.ts` (format, old checkpoints, repeated
saves) and `test/memory/resume.test.ts`. The latter covers few memories,
3,000 memories within budget, duplicates and nodes that are not memories,
a tiny budget that keeps the critical items, refs first, no checkpoint,
Grafeno unreachable, a failed search, an interrupted task in the old format,
lookup by task, and the size against the old start. The full CI passes
(351 tests), and so do `eval`, `eval:agents` and `eval:orchestration`.

### Using it from Claude Code directly (scenario B)

A `SessionStart` hook in `.claude/settings.local.json`. A hook's standard
output goes into the session's context before the first message:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node D:/Codes/Personal/grafeno-agent/dist/cli.js resume --compact",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

- `resume` (`claude --resume`) is left out on purpose: that conversation
  already has its history.
- The command reads Grafeno's address, key and namespace from Grafeno
  Agent's settings, or from `GRAFENO_URL`, `GRAFENO_AGENT_KEY` and
  `GRAFENO_NAMESPACE`. They must point at the namespace the MCP connection
  writes to. Never put a key in a file that is committed.
- With the hook in place, `CLAUDE.local.md` no longer needs to ask for
  `palace_map` + `palace_enter` at every start. It should say to go on from
  the compact resume and to use `recall` / `get_node` / `palace_enter` only
  when needed.

## Stage 3: budgets and progressive retrieval (done)

### The Memory Retrieval Budget Manager (`src/memory/budget.ts`)

Every memory tool of scenario A goes through `RetrievalBudget`. It has two
kinds of limit, and treats them differently:

| Limit                                                                                        | Kind | Default             | Past it                                                                                      |
| -------------------------------------------------------------------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------- |
| `resultChars`: the largest answer a lookup may put into the context                          | hard | 12,000 chars        | Cut at a line. The ids it left out are named, with a note to ask more narrowly or `get_node` |
| `callsPerTurn`: lookups in one turn                                                          | hard | 8                   | Refused, with a reason the model can act on. Stores are not counted                          |
| One deep look (`palace_map`, `palace_enter`, `palace_walk`, `timeline`) per turn             | hard | 1                   | Refused: use `recall` / `get_node`                                                           |
| `lookupItems`, `lookupTokens`: what each lookup asks Grafeno for                             | soft | 8 items, 800 tokens | Asked for less. The model may ask for fewer, never more                                      |
| `sessionTokens`: memory brought in on its own (resume and the `context` before each message) | soft | 20,000              | Nothing more comes on its own. The model may still look things up when it needs them         |
| `checkpoint`, `memories`, `maxMemories`: the compact resume                                  | soft | 500, 500, 5         | Listed by id                                                                                 |

It also shapes what comes back:

- A search's results become one compact line each,
  `[id] Name (Labels): text`, without the scores, reasons and
  justifications.
- Other structured answers become compact JSON.
- A memory already shown this session, including the ones in the resume,
  comes back as `[id] Name: shown earlier this session`.
- It counts calls, deep calls, refusals, automatic lookups and the ones
  skipped, tokens (all of them, and the ones brought in on its own), items
  returned, items deduplicated and cuts. That is `session.retrieval.stats`,
  for stage 5.

All of it is set with `AGENT_MEMORY_BUDGET`, for example
`checkpoint=400,callsPerTurn=4,sessionTokens=10000`. An unknown name or a
bad value is reported like any other setting.

Measured on the live server, the same answers before and after:

| Lookup                                | Before        | After         |
| ------------------------------------- | ------------- | ------------- |
| `recall` (Grafeno's default limit)    | ~2,183 tokens | ~1,130 (−48%) |
| `recall` limit 8                      | ~1,786        | ~892 (−50%)   |
| `palace_map` (palace "Grafeno Agent") | ~1,732        | ~1,070 (−38%) |
| `palace_enter` (room Orchestration)   | ~1,402        | ~1,299 (−7%)  |

### Levels

| Level | What                                               | How                                                                                                                       |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0     | The latest checkpoint and the next action          | `resume --compact --level 0`: 2 Grafeno calls, no search                                                                  |
| 1     | And the memories related to the task (the default) | `resume --compact`, and the start of scenario A                                                                           |
| 2     | Memories about something specific                  | `resume --compact --query "<topic>"`, or the model's `recall` / `get_node` within the lookup budget                       |
| 3     | Walking the palace                                 | `palace_map`, `palace_enter`, `palace_walk`, `timeline`: never part of a resume, one per turn, within the hard size limit |

The compact resume also leaves out weak matches: memories scoring below half
of the best match. This fixes what stage 2 noticed. On this task, the
default resume went from 5 memories (~788 tokens), some from old phases, to
the 2 that are about this work (~589 tokens). The other refs are still
listed by id. Level 0 was ~418 tokens.

### Scenario B, honestly

Claude Code talks to Grafeno's MCP server directly, so these budgets do not
apply to the lookups it makes on its own. What does apply: the hook's
compact resume (levels 0–2, with no model call), and instructions in
`CLAUDE.local.md` to look things up narrowly (`recall` with a `limit`,
`context` with a `budget`) and not to walk the palace to get started. A
proxy MCP server in front of Grafeno could apply the budgets there as well.
That is possible, but not built: it is another server to run, and it has
not been measured as needed.

Tests: `test/memory/budget.test.ts` (13 tests: soft and hard limits, one deep
look, cuts that name ids, compact lines, once per session, compact JSON,
`AGENT_MEMORY_BUDGET`, and the budget inside a memory session: refused
lookups, automatic lookups stopping, the resume counted), the relevance test
in `resume.test.ts`, and a settings test. The evaluation's fake model now
reads ids from the compact lines too (`test/eval/scenarios.ts`). Full CI:
366 tests. `eval` 9/9, `eval:agents` and `eval:orchestration` pass.

## Next: stage 4

Incremental consolidation and the context lifecycle:

- when a decision changes, update it and link the change (`supersedes`), so
  the old version is not shown as current, while its history is kept;
- deduplicate by meaning when storing;
- in scenario A, rotate on its own: when the cache is cold and the
  conversation is large, save a checkpoint and start a new conversation with
  the compact resume, never in the middle of a turn, without compacting
  again and again, and resetting what "shown earlier" means.
