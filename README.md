# Grafeno Agent

A programming assistant for the command line that remembers. It reasons
with Claude through your own Claude Code, and keeps what it learns about
each of your projects (decisions, facts, your preferences, where the work
stopped) in [Grafeno](https://github.com/grafenodb/grafeno), so the next
session picks up where the last one left off.

## What you need

- **Node.js 26.13 or later** (the current LTS).
- **Claude Code**, installed and signed in with your Claude subscription:
  run `claude` once and sign in with `/login`. The agent spends that
  plan's usage, exactly as if you asked Claude Code yourself; no API key,
  no other billing.
- **Memory (Grafeno)**: nothing to install beforehand. On first run you
  choose to **include Grafeno** (the agent downloads the official build and
  runs it on this computer; Windows x64 and Linux), or to connect to **a
  Grafeno server you already have** (0.3 or later), such as
  `http://127.0.0.1:7810`, with a key its administrator made for the agent.

## Install

```bash
npm install -g grafeno-agent
```

Or, from a copy of this repository:

```bash
npm install
npm run build
npm install -g .
```

The installation takes about 500 MB, most of it the runtime for the local
meaning model (`@huggingface/transformers`, an optional dependency). The
agent works without it, by words alone, if it is missing.

## Set up

Run `grafeno-agent` in a terminal. The first time, it asks two things:

1. **Where the agent keeps its memory.**
   - **Include Grafeno** (recommended): the official build of Grafeno is
     downloaded once, checked against its published checksum, and runs in
     the background on `127.0.0.1:7811` (so it never meets a Grafeno of your
     own on 7810). The agent makes its own key. Several agents share it.
   - **Connect to a Grafeno server**: its address, the agent's key and the
     namespace. The server's administrator makes the key:

     ```bash
     grafeno keys create grafeno-agent --grant grafeno-agent:write --config grafeno.toml
     ```

2. **The provider**: Claude, through your Claude Code. It shows whether
   Claude Code is installed and signed in, and with which plan.

Both are saved in the settings file: `%APPDATA%\grafeno-agent\config.env` on
Windows, `~/.config/grafeno-agent/config.env` elsewhere, or
`GRAFENO_AGENT_CONFIG`. Without a terminal, the same can be done with:

```bash
grafeno-agent init --include-grafeno
grafeno-agent init --grafeno-url http://127.0.0.1:7810 --key <key>
```

`grafeno-agent check` checks that Grafeno answers and the key works.

### Settings

| Variable            | Default                 | What                                                   |
| ------------------- | ----------------------- | ------------------------------------------------------ |
| `GRAFENO_MODE`      | `external`              | `included` (Grafeno runs with the agent) or `external` |
| `GRAFENO_URL`       | `http://127.0.0.1:7810` | The Grafeno server, when external                      |
| `GRAFENO_AGENT_KEY` | (required)              | The agent's key                                        |
| `GRAFENO_NAMESPACE` | `grafeno-agent`         | Where the agent keeps its memory                       |
| `AGENT_MODEL`       | `claude-code`           | The model (`claude-code`: your Claude subscription)    |
| `CLAUDE_MODEL`      | Claude Code's own       | `haiku`, `sonnet`, `opus`, `fable` (set by `/models`)  |
| `AGENT_EFFORT`      | the model's own         | `low` … `max` (set by `/effort`)                       |
| `AGENT_PROJECT`     | the git repository      | The project whose memory the agent uses                |
| `AGENT_EMBEDDER`    | `e5-small`              | Meaning for memory (a local model), or `none`          |
| `AGENT_PALACE`      | `shared`                | `shared` with other agents, or `own` (see below)       |
| `AGENT_SHELL`       | Git's bash on Windows   | The shell for commands, with its arguments             |

Variables set in the environment win over the file. The agent never reads
the `.env` of the folder it runs in: that belongs to your project.

## Use

Go to the project you want help with, and start it:

```bash
cd my-project
grafeno-agent
```

In a terminal it opens a full-screen interface, laid out like a desktop
app: the conversation in the middle, the box to type in below it (type `/`
for the commands), and a side panel with:

- **Model**: its exact name and effort ("Opus 5.5 · Medium"), the provider
  and your plan;
- **Context**: how full the model's context is;
- **Plan usage**: your provider's real usage (for Claude: the session and
  weekly limits, with when they reset), read from Claude Code itself
  without spending any of it;
- **This session**, **Environment** (project, git branch, changed files)
  and **Memory** (Grafeno, palace, agent).

The panel hides on narrow windows, or with Ctrl+B.

| Command        | What it does                                                    |
| -------------- | --------------------------------------------------------------- |
| `/help`        | Commands and keys                                               |
| `/new`         | A new conversation (the current one is kept)                    |
| `/resume`      | Take up an earlier conversation of this project                 |
| `/models`      | Choose the model, by its exact name                             |
| `/effort`      | Choose how hard the model thinks (Low … Max)                    |
| `/connect`     | The provider: Claude today, more later; whether it is signed in |
| `/palace`      | Grafeno: included, or a server you already have                 |
| `/usage`       | Your provider's real usage, and this session's tokens           |
| `/status`      | Provider, Grafeno, agent, project and model                     |
| `/memory`      | What memory brought back when the session started               |
| `/checkpoint`  | Save where the work stands, in memory                           |
| `/orchestrate` | Plan a request and run it with several workers (see below)      |
| `/runs`        | Earlier runs of this project: see one, or resume it             |
| `/upkeep`      | Report on the memory: duplicates, contradictions                |
| `/sidebar`     | Show or hide the side panel                                     |
| `/clear`       | Clear the conversation from the screen                          |
| `/exit`        | Leave, saving where the session stands                          |

Keys: Enter sends; `\` then Enter (or Shift+Enter) starts a new line; ↑ ↓
go through earlier messages; Tab completes a command; PgUp/PgDn scroll the
conversation (so does the mouse wheel; select text with Shift and the
mouse, or set `GRAFENO_AGENT_MOUSE=off`); Ctrl+B shows or hides the panel;
Esc interrupts the answer; Ctrl+C interrupts, or leaves.

Under each message, a line shows what memory brought to it: how many
memories and facts, and their names.

Conversations are kept on this computer (`%LOCALAPPDATA%\grafeno-agent\sessions`
on Windows, `~/.local/state/grafeno-agent/sessions` elsewhere, or
`GRAFENO_AGENT_DATA`), so `/resume` can take one up again: the model is
given the earlier conversation with your next message. Changing the model
with `/models`, or interrupting an answer, goes on the same way.

Piped input, or `grafeno-agent chat --plain`, talks line by line instead.

### What it may do

Its tools work only in the project's folder (the git repository you run it
in):

| Tool                                      | Permission                                                    |
| ----------------------------------------- | ------------------------------------------------------------- |
| `read_file`, `list_files`, `search_files` | runs freely                                                   |
| `write_file`, `edit_file`                 | asks you, showing the change                                  |
| `run_command`                             | runs freely when it only reads (`git status`…); else asks you |
| `web_fetch`                               | asks you                                                      |
| memory tools                              | run freely (the memory is the agent's own)                    |

These are never allowed, whatever the answer:

- leaving the project folder;
- files of secrets (`.env`, keys, credentials);
- raised privileges;
- deleting everything;
- forced pushes;
- running code downloaded from the internet;
- fetching addresses of this computer or its network.

These rules guard against mistakes. They are not a sandbox: a command you
allow runs with your rights, so read what you allow.

## Memory

What the agent knows lives in Grafeno, in its namespace, with one palace
per project. A session:

- starts from the project's room and the latest checkpoint;
- before each message, looks up what memory holds about it;
- during the session, stores decisions, facts, preferences and open
  questions;
- when you leave, saves a checkpoint.

It does not store the same thing twice. When something stops being true,
it marks the old memory obsolete instead of keeping both. It never stores
keys, passwords or tokens. To look after the memory (the chat reminds you
each week):

```bash
grafeno-agent upkeep           # report duplicates, contradictions, what to rearrange
grafeno-agent upkeep --apply   # also carry out the safe fixes, each with its reason
```

With `AGENT_EMBEDDER=e5-small` (the default), memory is searched by
meaning too. The first session downloads a small multilingual model (about
130 MB) into `~/.cache/grafeno-agent/models`; it runs on this computer.
With it, the memory that answers a question reached the model 93% of the
time instead of 63% on the measured set (`docs/measurements/`). If the
model is not installed or fails, memory works by words alone.

### Several workers on one request

`/orchestrate <request>` (or `grafeno-agent run "<request>"`) turns a
request into a plan of tasks with dependencies, shows it, and, when you say
so, runs it with several workers at once:

- each task works in its own **git worktree and branch**; your working tree
  and branch are never written;
- each worker gets the model and effort its task needs (architecture and
  hard backend work on the deepest model, tests and docs on the lightest),
  checked against what your provider really offers and how much of your plan
  is used;
- workers share memory through Grafeno: decisions of the tasks they build
  on reach them, with who made them;
- a task is done only when its **checks pass, run by code** (its tests,
  typecheck, build or files); a failed check goes back to its worker;
- finished tasks are merged into the run's **integration branch**
  (`grafeno/<run>/integration`); you look at it and merge it yourself.

The run's policy decides what workers may do alone: `controlled` (default)
lets them write in their worktree and run checks and builds; `supervised`
asks for every change; `extended` allows commands in the worktree. Pushing,
publishing, deploying, infrastructure and deleting folders are always asked.
Commands run with your rights: the worktree is the boundary, not a sandbox.

```bash
grafeno-agent run "add an orders API with tests" --workers 3
grafeno-agent run "three small utilities with tests" --light --yes   # light models, low effort
grafeno-agent runs              # this project's runs
grafeno-agent runs <id>         # one run's report
grafeno-agent resume <id>       # go on with a paused or waiting run
```

Runs are kept in the agent's data folder, so a run stopped by closing the
terminal, by a pause or by your plan's limit is resumed where it stopped.

### Several agents

Several agents can work on one project at the same time, sharing its
memory. Give each one a key of its own: its name is the agent's name, and
Grafeno records it on everything the agent writes. With `--own-only`, an
agent may read and add to all the memory but change only what it recorded
itself, so no agent can undo another's work:

```bash
grafeno keys create grafeno-agent-dev    --grant grafeno-agent:write --own-only --config grafeno.toml
grafeno keys create grafeno-agent-review --grant grafeno-agent:write --own-only --config grafeno.toml
```

Each agent runs with its own settings file (`GRAFENO_AGENT_CONFIG`) holding
its key. `grafeno-agent check` shows the name it works under.

- The project's palace is shared: what one agent stores reaches the
  others. When an agent finds another's memory wrong, it stores the
  corrected one and relates it with `supersedes`; it does not change the
  other's memory.
- Each agent saves its own checkpoints, and comes back to them. A newer
  checkpoint saved by another agent is shown too, as that agent's work.
- `AGENT_PALACE=own` gives an agent a palace of its own,
  `<project> · <agent>`, for work apart from the others.
- In Grafeno Studio, each memory and fact shows who recorded it, and each
  agent has a node of its own, linked to the project it `works_on`.

## Troubleshooting

| Message                                          | What to do                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `GRAFENO_AGENT_KEY is not set`                   | `grafeno-agent init`, then put the key in the settings file           |
| `Grafeno does not answer at …`                   | Start the Grafeno server (on Windows, the service `grafeno`)          |
| `Grafeno refused the agent's key`                | The key is wrong, revoked or expired: ask for a new one               |
| `The agent's key may not use namespace …`        | The key needs `--grant <namespace>:write`, or set `GRAFENO_NAMESPACE` |
| `Claude Code was not found` / `is not signed in` | Install Claude Code, run `claude`, sign in with `/login`              |
| `The Claude plan's usage limit is reached`       | Wait until the time it says; the agent does not work around it        |

## How it works

- The agent starts the official `claude` program, signed in with your
  subscription. It never reads or handles Claude's credentials.
- Claude Code's own tools are turned off, and Claude gets only the
  agent's tools. They are served over MCP from the agent's process on
  127.0.0.1, with a secret for each conversation.
- Everything outside `src/model` sees only the model interface
  (`src/model/types.ts`), so another model can take Claude's place.
- The plan and its status are in [ROADMAP.md](ROADMAP.md). How releases
  are made is in [RELEASING.md](RELEASING.md).

## Development

```bash
npm run ci               # typecheck, lint, format check, tests, build
npm test                 # unit tests: no server, no model usage
npm run chat             # the agent from the source (reads ./.env)
npm run test:live        # against the Grafeno server in .env
npm run test:live:model  # the model contract on real Claude (spends a little plan usage)
npm run eval             # the evaluation suite on the fake model (needs `grafeno` or GRAFENO_BIN)
npm run eval:real        # the same suite on Claude Haiku (spends plan usage)
npm run eval:agents      # several agents on one task at once (fake model, Grafeno in memory)
npm run eval:orchestration  # workers of a run sharing memory (fake model, Grafeno in memory)
npm run preview:tui -- 100 30   # the interface at a size, with a scripted answer (no plan usage)
npm run measure:meaning  # what meaning adds to recall
```

The evaluation runs nine scenarios end to end against a Grafeno of its
own in memory. It records recall, needless memories, duplicates refused,
tokens and time per turn in `docs/eval/`, and fails when a result falls
below `test/eval/baseline.json` (`-- --update-baseline` accepts new
results).

## License

MIT or Apache-2.0, at your choice: [LICENSE-MIT](LICENSE-MIT),
[LICENSE-APACHE](LICENSE-APACHE).
