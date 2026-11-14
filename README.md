# Grafeno Agent

A programming assistant for the command line that remembers. It reasons
with Claude through your own Claude Code, and keeps what it learns about
each of your projects (decisions, facts, your preferences, where the work
stopped) in [Grafeno](https://github.com/grafenodb/grafeno), so the next
session picks up where the last one left off.

## What you need

- **Node.js 22.18 or later.**
- **Claude Code**, installed and signed in with your Claude subscription:
  run `claude` once and sign in with `/login`. The agent spends that
  plan's usage, exactly as if you asked Claude Code yourself; no API key,
  no other billing.
- **A Grafeno server** (0.3 or later) that you can reach, such as one
  installed on this computer (`http://127.0.0.1:7810`), and **a key for the
  agent** made by the server's administrator.

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

1. Write the settings file:

   ```bash
   grafeno-agent init
   ```

   It says where it wrote it: on Windows,
   `%APPDATA%\grafeno-agent\config.env`; elsewhere,
   `~/.config/grafeno-agent/config.env`. `GRAFENO_AGENT_CONFIG` points to
   another file.

2. Get the agent's key. The administrator of the Grafeno server makes it,
   as an administrator (for the Windows service, in a terminal opened as
   administrator, with `--config C:\ProgramData\Grafeno\grafeno.toml`):

   ```bash
   grafeno keys create grafeno-agent --grant grafeno-agent:write --config grafeno.toml
   ```

   The secret is shown once. Put it in the settings file as
   `GRAFENO_AGENT_KEY`. It is a secret: keep it in that file only.

3. Check that Grafeno answers and the key works:

   ```bash
   grafeno-agent check
   ```

### Settings

| Variable            | Default                 | What                                                |
| ------------------- | ----------------------- | --------------------------------------------------- |
| `GRAFENO_URL`       | `http://127.0.0.1:7810` | The Grafeno server                                  |
| `GRAFENO_AGENT_KEY` | (required)              | The agent's key                                     |
| `GRAFENO_NAMESPACE` | `grafeno-agent`         | Where the agent keeps its memory                    |
| `AGENT_MODEL`       | `claude-code`           | The model (`claude-code`: your Claude subscription) |
| `CLAUDE_MODEL`      | Claude Code's own       | `haiku`, `sonnet`, `opus`…                          |
| `AGENT_PROJECT`     | the git repository      | The project whose memory the agent uses             |
| `AGENT_EMBEDDER`    | `e5-small`              | Meaning for memory (a local model), or `none`       |
| `AGENT_PALACE`      | `shared`                | `shared` with other agents, or `own` (see below)    |
| `AGENT_SHELL`       | Git's bash on Windows   | The shell for commands, with its arguments          |

Variables set in the environment win over the file. The agent never reads
the `.env` of the folder it runs in: that belongs to your project.

## Use

Go to the project you want help with, and start it:

```bash
cd my-project
grafeno-agent
```

Type to talk. The agent shows each tool it uses. In the chat:

- `/usage` shows what the session spent and how full your plan's usage
  windows are (it warns at 80%);
- `/help` lists the commands;
- `/exit` or Ctrl+D leaves, saving where the session stands;
- Ctrl+C cancels the answer being written. This also ends the conversation
  with Claude Code: the next message starts a new one (memory remains),
  and the agent says so.

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
