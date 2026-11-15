# Changelog

## 0.1.1 (2026-11-15)

- **Permissions** (`/permissions`): **Ask** (the default), **Automatic**
  (the agent decides by risk, in code: project changes, checks and builds
  run; deleting, pushing, publishing, installing and reaching outside ask)
  or **Skip permissions** (nothing is asked). For the whole agent
  (`AGENT_PERMISSIONS`), this session only, or this session and its
  sub-agents (their runs' policy lets through what the mode allows). What
  is never allowed stays so in every mode. `run --permissions`.
- **Unattended operation** (`/unattended`, `run --unattended`): permissions
  skipped for the session and its sub-agents, plans run without being
  confirmed, runs in extended mode (retries, replans, merges when checks
  pass), and the model told nobody is watching, to work on until the task
  is done. The footer shows it.
- **Answers in your language**: each message's language is told from its
  words (Spanish, English, Portuguese, French, German, Italian), and the
  model is reminded just before your words to answer in it, since memory,
  files and tool output are often in another language. A message too short
  to tell keeps the language before.
- **Your Grafeno or the agent's own**: the first run looks for a Grafeno on
  this computer and offers it by version and address, beside the agent's
  own (self-hosted on 127.0.0.1:7811 with its own data, leaving yours
  untouched), or another server. Settings that never chose
  (`GRAFENO_MODE` empty, now the template's default) are asked at start.
- **The sub-agent on screen is marked**: in the left panel as a selection
  (a bar and an inverted band), and at the bottom ("Viewing task-2 · 2
  of 5").
- **Checked for real**: with Claude Code, the agent made folders, wrote
  TypeScript and a test, ran `node --test` (2 of 2 passing) and answered
  in Spanish.

## 0.1.0 (2026-11-15)

The first version: a programming assistant with long-term memory in
Grafeno, used from the command line.

- **Installs as a terminal command**: `grafeno-agent`, from the latest
  GitHub release (`npm install -g
https://github.com/grafenodb/grafeno-agent/releases/latest/download/grafeno-agent.tgz`,
  the package already built) or from a copy of the repository
  (`npm run build`, then `npm link`). A tag makes the GitHub release with
  the packed package; npm publishing waits until the package is public.

- **The panel's usage stays current**: read again every minute (what is
  spent in another app or terminal shows within a minute), asked anew
  after each answer instead of through the one-minute cache, and "n min
  ago" kept true while idle. A failed reading keeps the last one, marked as
  old, instead of silently showing it as current. In Auto, the same for
  each included provider (an API key's credits too).

- **More tools for the environment**: `environment_info` (the system, the
  shell, the branch and the development programs installed), `file_info`,
  `multi_edit` (several edits to one file, all or none), `move_file`,
  `delete_file` (a file or an empty folder), background processes
  (`start_process`, `process_output`, `list_processes`, `stop_process`: a
  dev server or a watcher, stopped when the agent ends) and `local_http`
  (a server on this computer; GET and HEAD run freely, other methods ask).
- **Plugins**: GitHub and GitLab, off until turned on with
  `grafeno-agent plugins enable <id>` (checked first). They sign in only as
  the services document: the official `gh` / `glab` CLI's own sign-in (its
  token never read), or a personal access token you made. Reading runs at
  once; opening, commenting or any other change asks; secrets, keys,
  tokens and deleting a whole repository are never touched. `/plugins`
  shows them.
- **Grafeno's own MCP server is listed** first in `/mcp` and
  `grafeno-agent mcp`, built in and always on: it cannot be turned off or
  removed, and its name is reserved.
- **Auto is the first row of `/connect`**, above every provider; the panel
  opens on what is in use.

- **Orchestration (phase A)**: `/orchestrate <request>` and
  `grafeno-agent run|runs|resume` plan a request into a DAG of tasks checked
  by code and run it with several workers at once: each in its own git
  worktree, routed to the model and effort its task needs, sharing memory
  through Grafeno, verified by code, merged into an integration branch under
  a `supervised` / `controlled` / `extended` policy, with sessions renewed
  when their context fills up and every run kept for resuming. Design and
  progress in `docs/orchestration.md`; first real runs in
  `docs/measurements/orchestration-2026-11-15.md`. The project now needs
  Node 26.13 or later.

- **Include Grafeno**: on first run (or `init --include-grafeno`) the agent
  can download the official Grafeno build, checked against its checksum,
  and run it in the background on 127.0.0.1:7811, making its own key; or
  connect to a Grafeno server the user has (`GRAFENO_MODE`).
- **Providers**: a provider interface, with Claude (Claude Code) first.
  `/connect` shows whether it is installed and signed in, and the plan;
  `/palace` changes the Grafeno connection; `/models` lists models by
  their exact names and `/effort` sets the effort (`AGENT_EFFORT`), both
  remembered. `/usage` and the panel show the provider's real usage
  (Claude Code's own `/usage`, which spends nothing).
- **Memory you can see**: under each message, a line says what memory
  brought to it (how many memories and facts, and their names); the side
  panel keeps it for the last message.
- **Mouse wheel**: it scrolls the conversation (the terminal's mouse
  reports are read; Shift and the mouse select text;
  `GRAFENO_AGENT_MOUSE=off` leaves the mouse to the terminal). `/usage`
  puts each reset on its own line.
- **From real use**: markdown tables are drawn (short columns whole, the
  last one wraps); the context bar shows the model's capacity once Claude
  Code tells it; usage bars line up; the header and footer shorten
  instead of wrapping; a compact start screen in short windows; the side
  panel clips instead of squashing lines. The effort setting is now
  `AGENT_EFFORT` (Claude Code sets `CLAUDE_EFFORT` for its own children).
  `npm run preview:tui` shows the layout at any size without plan usage.
- **Desktop layout**: full screen, the conversation in the middle with its
  own scrolling, a side panel (model, context, plan usage, session,
  environment, memory) and Grafeno's mark drawn for the terminal.
- **Terminal interface**: in a terminal, the chat opens a full interface
  (Ink): the conversation with answers rendered from markdown, the tools
  used, a box with the slash commands offered as one types, permission
  prompts, and a status line (agent, project, model, tokens, plan window).
  Commands: `/help`, `/new`, `/resume`, `/models`, `/connect`, `/usage`,
  `/status`, `/memory`, `/checkpoint`, `/upkeep`, `/clear`, `/exit`.
  Conversations are kept on disk per project; resuming one, changing the
  model or interrupting gives the model the earlier conversation as data,
  so it works the same with any model. `--plain` (or piped input) keeps
  the line-by-line chat.
- **Several agents**: an agent's name is its Grafeno key's name (read with
  `whoami`), recorded on everything it writes. With `--own-only` keys,
  agents share a project's memory but change only what they recorded; a
  refusal tells the model to supersede instead. The project's node is
  shared and found before it is made, so agents starting at once use one.
  Each agent has a node of its own, saves checkpoints under its name and
  comes back to its own, and is told of a newer one by another agent.
  `AGENT_PALACE=own` keeps an agent's memory in a palace of its own.
  `npm run eval:agents` checks it with two agents at once.

- **Model**: Claude through the user's own Claude Code (their subscription;
  no API key). Claude is used as the brain only: Claude Code's own tools
  are turned off, and it gets the agent's tools over a local MCP server.
  Time limits and retries; the plan's usage windows are shown, and the
  agent stops at the plan's limit.
- **Memory**: a palace per project in the agent's own Grafeno namespace.
  Sessions start from the project's room and latest checkpoint, look up
  memory before each message, and save a checkpoint at the end. No
  duplicates; what stopped being true is marked obsolete, not kept beside
  the new; secrets are never stored. `grafeno-agent upkeep` looks after it.
- **Meaning**: memories and questions carry vectors from a local
  multilingual model (optional; about 130 MB, downloaded once). Measured:
  the right memory reaches the model 93% of the time instead of 63%.
- **Tools**: read, list, search, write and edit files of the project, run
  commands and read web pages, each with a permission: runs freely, asks
  first, or never. Files of secrets, raised privileges, destructive and
  downloaded commands, and addresses of this computer's network are never
  allowed.
- **Evaluation**: nine end-to-end scenarios, measured on every change
  against a baseline.
- **Settings**: a settings file of the user's (`grafeno-agent init`); the
  `.env` of the project the agent runs in is never read.
