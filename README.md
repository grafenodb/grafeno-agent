# Grafeno Agent

A programming assistant with long-term memory. Its reasoning comes from a
language model that can be swapped; what it knows is kept in
[Grafeno](https://github.com/grafenodb/grafeno), through
[`@grafenodb/client`](https://www.npmjs.com/package/@grafenodb/client).
The plan is in [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 22.18 or later (what `@grafenodb/client` needs).
- A Grafeno server, and a key of the agent's own made by its administrator.
- For the first model: Claude Code installed and logged in.

## Set up

```bash
npm install
cp .env.example .env
```

An administrator makes the agent's key on the Grafeno server; the secret
is printed once:

```bash
grafeno keys create grafeno-agent --grant grafeno-agent:write --config grafeno.toml
```

Put it in `.env` as `GRAFENO_AGENT_KEY`. Never commit `.env`.

| Variable            | Default                 | What                                            |
| ------------------- | ----------------------- | ----------------------------------------------- |
| `GRAFENO_URL`       | `http://127.0.0.1:7810` | The Grafeno server                              |
| `GRAFENO_AGENT_KEY` | (required)              | The agent's key                                 |
| `GRAFENO_NAMESPACE` | `grafeno-agent`         | Where the agent keeps its memory                |
| `AGENT_MODEL`       | `claude-code`           | The model adapter (`claude-code`: subscription) |
| `CLAUDE_MODEL`      | Claude Code's own       | For `claude-code`: `haiku`, `sonnet`, `opus`…   |
| `AGENT_PROJECT`     | the git repository      | The project whose memory the agent uses         |
| `AGENT_EMBEDDER`    | `e5-small`              | Meaning for memory (local), or `none`           |

With `e5-small`, the first session downloads a small multilingual model
(about 130 MB) into `~/.cache/grafeno-agent/models`; it runs on this
computer, with no service and no API. With it, the memory that answers a
question reaches the model 93% of the time instead of 63% on the measured
set (`docs/measurements/`; `npm run measure:meaning` measures it again).

Then check that Grafeno answers and the key works:

```bash
npm run check
```

## Use

```bash
npm run chat
```

Type to talk; the agent shows each tool it uses, and asks before any tool
that changes something. `/usage` shows what the session spent and how full
the plan's usage windows are; `/exit` or Ctrl+D leaves; Ctrl+C cancels the
answer being written (with Claude Code, that also ends the conversation:
the next message starts a new one, and the agent says so).

## Memory

What the agent knows lives in Grafeno, in its namespace, one palace per
project (the git repository it runs in, or `AGENT_PROJECT`). When a
session starts, the agent brings back the project's room and its latest
checkpoint; before each message it looks up what memory knows about it;
during the session it stores decisions, facts, preferences and open
questions; when you leave, it saves a checkpoint, so the next session
picks up where this one stopped. It never stores keys, passwords or
tokens: storing them is refused.

It does not store the same thing twice, and when something stops being
true it marks the old memory obsolete and links the new one to it, instead
of keeping both. To look after the memory:

```bash
npm run upkeep            # report duplicates, contradictions, what to rearrange
npm run upkeep -- --apply # also carry out the safe fixes, each with its reason
```

The chat reminds you when upkeep has not run for a week.

## The model

The agent reasons with Claude through your own Claude Code: it starts the
official `claude` program, signed in with your subscription, and what it
asks counts against your plan exactly as if you asked it. It never reads
or handles Claude's credentials. Claude Code's own tools are turned off;
Claude gets only the agent's tools, served over MCP from the agent's
process on 127.0.0.1 with a per-conversation secret. When the plan's
usage limit is reached, the agent stops and says when it resets.

Everything else in the agent sees only the model interface in
`src/model/types.ts`; a scripted fake model (`FakeModel`) stands in for
Claude in tests.

## Development

```bash
npm run ci               # typecheck, lint, format check, tests, build
npm test                 # unit tests: no server, no model usage
npm run test:live        # against the Grafeno server in .env
npm run test:live:model  # the model contract on real Claude (spends a little plan usage)
```
