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
- **Codex CLI** (optional), a second provider with your ChatGPT
  subscription: `npm install -g @openai/codex`, then `codex login`. See
  [Several providers](#several-providers).
- **Gemini** (optional), through Google AI Studio's API with your own key:
  `grafeno-agent login gemini`. No program to install.
- **OpenRouter** (optional), with your own key: `grafeno-agent login
openrouter`. Free models only by default.
- **Memory (Grafeno)**: nothing to install beforehand. On first run you
  choose to **include Grafeno** (the agent downloads the official build and
  runs it on this computer; Windows x64 and Linux), or to connect to **a
  Grafeno server you already have** (0.3 or later), such as
  `http://127.0.0.1:7810`, with a key its administrator made for the agent.

## Install

It installs as a command, `grafeno-agent`, that you run in any project
folder, like other terminal assistants.

**From the latest release** (no copy of the repository needed): the
release carries the package already built.

```bash
npm install -g https://github.com/grafenodb/grafeno-agent/releases/latest/download/grafeno-agent.tgz
```

**From a copy of this repository**, to follow your own changes:

```bash
npm install
npm run build
npm link
```

`npm link` makes `grafeno-agent` a command that runs this copy's build:
after changing the code, `npm run build` is enough (`npx tsc -p
tsconfig.build.json --watch` rebuilds as you go). `npm unlink -g
grafeno-agent` removes the command.

Then, in any folder:

```bash
grafeno-agent            # the interface
grafeno-agent version
grafeno-agent help
```

The installed command reads its settings from the settings file
(`%APPDATA%\grafeno-agent\config.env` on Windows,
`~/.config/grafeno-agent/config.env` elsewhere), never the `.env` of the
folder it runs in: that one belongs to your project. Run from the source
(`npx tsx src/cli.ts`), it also reads this repository's `.env`.

The installation takes about 500 MB, most of it the runtime for the local
meaning model (`@huggingface/transformers`, an optional dependency). The
agent works without it, by words alone, if it is missing or does not load.
npm may warn that it did not run the install scripts of `onnxruntime-node`
and `protobufjs` (it asks before running scripts of dependencies). `npm
uninstall -g grafeno-agent` removes the command.

## Set up

Run `grafeno-agent` in a terminal. The first time, it asks two things:

1. **Where the agent keeps its memory.** It first looks for a Grafeno
   already running on this computer (at `GRAFENO_URL`, else
   `127.0.0.1:7810`) and says what it found.
   - **The agent's own Grafeno** (recommended): self-hosted by the agent,
     apart from any Grafeno you have, so yours stays untouched. The official
     build is downloaded once, checked against its published checksum, and
     runs in the background on `127.0.0.1:7811` with its own data. The
     agent makes its own key. Several agents share it.
   - **The Grafeno on this computer**, when one answers: its version and
     address are shown; the agent's memory goes in a namespace of its own
     there, with a key its administrator makes (below).
   - **Another Grafeno server**: its address, the agent's key and the
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
`/palace` changes the choice later. While `GRAFENO_MODE` is empty, the
agent asks again when it starts.

### Settings

| Variable               | Default                 | What                                                                      |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `GRAFENO_MODE`         | (asked)                 | `included` (the agent's own Grafeno) or `external`; empty: asked at start |
| `GRAFENO_URL`          | `http://127.0.0.1:7810` | The Grafeno server, when external                                         |
| `GRAFENO_AGENT_KEY`    | (required)              | The agent's key                                                           |
| `GRAFENO_NAMESPACE`    | `grafeno-agent`         | Where the agent keeps its memory                                          |
| `AGENT_MODEL`          | `claude-code`           | The model (`claude-code`: your Claude subscription)                       |
| `CLAUDE_MODEL`         | Claude Code's own       | `haiku`, `sonnet`, `opus`, `fable` (set by `/models`)                     |
| `AGENT_EFFORT`         | the model's own         | `low` … `max` (set by `/effort`)                                          |
| `AGENT_PROJECT`        | the git repository      | The project whose memory the agent uses                                   |
| `AGENT_EMBEDDER`       | `e5-small`              | Meaning for memory (a local model), or `none`                             |
| `AGENT_PALACE`         | `shared`                | `shared` with other agents, or `own` (see below)                          |
| `AGENT_SHELL`          | Git's bash on Windows   | The shell for commands, with its arguments                                |
| `AGENT_PROVIDERS`      | `auto`                  | `claude-code`, `codex`, `gemini`, in order, or `auto` (set by `/connect`) |
| `AGENT_AUTO_PROVIDERS` | none (you choose)       | The providers Auto includes (set in `/connect` with space)                |
| `GEMINI_TIER`          | none                    | `free` or `paid`: your Gemini key's tier (set by `login gemini`)          |
| `OPENROUTER_MODELS`    | `free`                  | `free` (never billed) or `all` (set by `login openrouter`)                |
| `AGENT_ALLOW_BILLING`  | none                    | Providers allowed to bill by consumption, such as `gemini`                |
| `AGENT_AFFINITY`       | the defaults below      | Where each task kind goes first in `auto`                                 |
| `AGENT_MEMORY_BUDGET`  | see [Memory](#memory)   | How much memory may reach the model                                       |

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
  without spending any of it. It is read again every minute, so what you
  spend elsewhere (Claude Code Desktop, another terminal) shows within a
  minute, and asked anew after each answer. When a reading fails, the last
  one stays, said to be old;
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
| `/agents`      | The main agent and its sub-agents: view one, read only          |
| `/skills`      | The skills the agent can use                                    |
| `/mcp`         | MCP servers: Grafeno's own (always on) and yours                |
| `/plugins`     | Services the agent works with: GitHub, GitLab                   |
| `/upkeep`      | Report on the memory: duplicates, contradictions                |
| `/sidebar`     | Show or hide the side panel                                     |
| `/clear`       | Clear the conversation from the screen                          |
| `/exit`        | Leave, saving where the session stands                          |

Keys: Enter sends; `\` then Enter (or Shift+Enter) starts a new line; ↑ ↓
go through earlier messages; Tab completes a command; PgUp/PgDn scroll the
conversation (so does the mouse wheel; select text with Shift and the
mouse, or set `GRAFENO_AGENT_MOUSE=off`); Ctrl+B shows or hides the panel;
Ctrl+N and Ctrl+P go through the main agent and its sub-agents;
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

| Tool                                                           | Permission                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| `read_file`, `list_files`, `search_files`, `file_info`         | runs freely                                                   |
| `environment_info` (system, shell, branch, programs installed) | runs freely                                                   |
| `write_file`, `edit_file`, `multi_edit`                        | asks you, showing the change                                  |
| `move_file`, `delete_file` (a file or an empty folder)         | asks you                                                      |
| `run_command`                                                  | runs freely when it only reads (`git status`…); else asks you |
| `start_process` (a dev server or a watcher, in the background) | asks you                                                      |
| `process_output`, `list_processes`, `stop_process`             | run freely (only the agent's own processes)                   |
| `local_http` (a server on this computer: localhost)            | GET and HEAD run freely; other methods ask you                |
| `web_fetch`                                                    | asks you                                                      |
| memory tools (from Grafeno's MCP server)                       | run freely (the memory is the agent's own)                    |
| plugin tools (GitHub, GitLab: see below)                       | reading runs freely; anything that changes something asks you |

Background processes stop when the agent ends; at most eight run at once.
Workers of a run (`/orchestrate`) get the same tools except background
processes and plugins.

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

## Skills

A **skill** is a folder with a `SKILL.md` in the open
[Agent Skills](https://agentskills.io) format. Its front matter says what
the skill does and when to use it; its body says how, and it may carry
scripts, references and assets.

- **Where the agent reads them:** the project's `.agents/skills`, then your
  own `~/.agents/skills` and `~/.config/agents/skills`. A project's skill
  hides one of yours with the same name.
- **How it uses them:** the agent (and every sub-agent) is told each
  skill's name and description. When a task matches one, it loads the
  skill's instructions with its `skill` tool, and reads the skill's own
  files with the same tool (never anything outside the skill's folder).

```bash
grafeno-agent skills                                   # the skills, and any problem
grafeno-agent skills find pdf                          # search (the Skills CLI)
grafeno-agent skills add vercel-labs/agent-skills --skill frontend-design
grafeno-agent skills add owner/repo -g                 # for all your projects
grafeno-agent skills new release-notes --description "Write release notes from the git log. Use when releasing."
grafeno-agent skills remove frontend-design
```

- **Installing** goes through the official Skills CLI (`npx skills`, by
  Vercel Labs; Node 22.20 or later), for its `universal` agent, whose
  folders are the ones above.
- **Your own skills** start from `skills new`: the name and description are
  checked against the format's rules, and you write the steps.
- **Trust:** treat a skill like code. Its scripts run with your rights, as
  the agent's commands do, asking you first.

## Plugins

Plugins let the agent work with services outside this computer, as you:
read and open issues, pull requests and merge requests, follow CI, search,
and call the service's REST API for the rest.

| Plugin   | What it does                                                 | Sign-in                                                     |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `github` | Repositories, issues, pull requests (files, checks), search  | the `gh` CLI's own (`gh auth login`), or `GITHUB_TOKEN`     |
| `gitlab` | Projects, issues, merge requests, pipelines and jobs, search | the `glab` CLI's own (`glab auth login`), or `GITLAB_TOKEN` |

```bash
grafeno-agent plugins                  # each one: on or off, connected or not, its terms
grafeno-agent plugins enable github    # checked first: turned on only when connected
grafeno-agent plugins disable github
```

- **Off until you turn one on** (`AGENT_PLUGINS`). Turning one on checks the
  connection first, and says the service's terms.
- **Only sign-ins the services document.** The official CLI's own sign-in
  comes first: the agent asks the CLI to make each request (`gh api`,
  `glab api`) and never reads its token. Otherwise a personal access token
  you made, in the environment. No sign-in flow of the agent's own, no
  tokens taken from other programs, no scraping of web pages.
- **Within the service's terms.** Each plugin uses the service's public
  REST API (GitHub's, GitLab's v4), with your account's own permissions and
  rate limits. Give a token only the scopes you want the agent to have
  (`read_api` on GitLab to only read).
- **A GitLab of your own:** set `GITLAB_HOST` (such as `git.example.com`).
- **The repository** of a call is the project's own git remote, unless the
  model names another.
- **Permissions.** Reading runs at once. Opening an issue, a pull or merge
  request, or commenting asks you, showing what will be posted. Raw API
  calls (`github_api`, `gitlab_api`): GET runs, any other method asks.
  Never, whatever the answer: secrets, CI variables, keys and tokens;
  deleting or transferring a whole repository, project, group or
  organization; changing the account itself; webhooks.
- `/plugins` shows the session's plugins. A plugin turned on but not
  connected is said when a session starts.

## MCP servers

**Grafeno's own MCP server** comes first: the agent's memory tools are
those of its namespace's MCP endpoint. It is built in and always on: it
cannot be turned off or removed, and no server you add may take its name
(`grafeno`), since the agent works through it. `/mcp` and
`grafeno-agent mcp` list it first.

The agent can also use the tools of MCP servers you add: a program on this
computer (stdio) or a server at a URL (Streamable HTTP). They are kept in
`mcp.json`, next to the settings file.

```bash
grafeno-agent mcp add files -- npx -y @modelcontextprotocol/server-filesystem ./docs
grafeno-agent mcp add github --url https://api.githubcopilot.com/mcp/ --header 'Authorization=Bearer ${GITHUB_TOKEN}'
grafeno-agent mcp                     # each server, checked: its tools, or why not
grafeno-agent mcp remove files
```

- **Checked when added.** Adding connects to the server first and keeps it
  only when it answers (`--force` keeps it anyway). `grafeno-agent mcp`
  checks every server again.
- **Secrets stay out of the file.** A value may name an environment
  variable as `${NAME}` (in single quotes, so that your shell leaves it as
  it is). A token written in full is refused when added.
  A program gets a minimal environment plus what its configuration sets,
  never the agent's own keys.
- **Permissions.** Each tool reaches the agent as
  `mcp_<server>_<tool>`. It asks you before it runs, unless the server
  marks it read-only. A server that is not reached when a session starts is
  said, and the session goes on without it.
- External MCP tools are the chat agent's; sub-agents do not get them yet.

## Memory

What the agent knows lives in Grafeno, in its namespace, with one palace
per project. A session:

- starts from a **compact resume**: the latest checkpoint (the task, its
  next action, what is pending or blocked, open errors, decisions, files)
  and a few memories about it, within a budget, with the rest listed by id
  to look up when needed. The palace is not walked;
- before each message, looks up what memory holds about it;
- during the session, stores decisions, facts, preferences and open
  questions;
- when you leave, saves a checkpoint.

It does not store the same thing twice. When something stops being true,
it revises it: the new memory supersedes the old one, which is marked
obsolete and kept for its history. It never stores keys, passwords or
tokens.

Memory lookups have budgets (`AGENT_MEMORY_BUDGET`, such as
`checkpoint=400,callsPerTurn=4,sessionTokens=10000`): hard limits on the
size of an answer and on lookups per turn, and softer ones on what each
lookup asks for and on memory brought in on its own. After a long pause,
when the prompt cache has gone cold and the conversation is large, the
agent starts a fresh conversation from a checkpoint instead of sending the
old one again, and says so. Why and what was measured:
[`docs/memory-retrieval.md`](docs/memory-retrieval.md).

When you use Claude Code directly with Grafeno over MCP, a `SessionStart`
hook can give each new session the same compact resume, without a model
call: `grafeno-agent resume --compact` (`--level 0` for the checkpoint
alone, `--query "<topic>"` for something specific). The hook is in
[`docs/memory-retrieval.md`](docs/memory-retrieval.md). To look after the memory (the chat reminds you
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

### Sub-agents

The agent you chat with can start **sub-agents** itself, on any provider,
when the work has parts that can go on at once: it calls its `delegate`
tool with the request. That works the same as `/orchestrate`:

- a plan is shown, and nothing runs until you choose **Run it**;
- each sub-agent works on one task, in its own worktree, with its own
  checks;
- the main agent gets the run's report and goes on from it.

In Auto the sub-agents use every ready provider; with a named provider
they all use that one.

While they work, the **agents panel** on the left lists the main agent and
each sub-agent: its model and effort, and what it is doing now (writing,
the tool it runs, done, waiting for a person). The right panel, with your
plan's usage, stays as it was.

- **Ctrl+N / Ctrl+P**, or `/agents`, show another agent's work as it goes:
  its words and the tools it used.
- A sub-agent is **read only**: it takes no prompts, because the main agent
  orchestrates it. Go back to the main agent to write.
- The panel shows when the window is wide enough (140 columns with the
  right panel, 100 without: Ctrl+B hides it). The keys and `/agents` work
  in any width.

### Several providers

Besides Claude Code, the agent can reason with **Codex CLI**, OpenAI's
official CLI, signed in with your ChatGPT subscription, and with **Gemini**
(Google AI Studio) and **OpenRouter**, each with your own API key.

- **Auto is always the first row of `/connect`**, above every provider.
  The panel opens on what is in use.
- **Auto uses only what you include, and starts with nothing.** In
  `/connect`, each provider says whether it is in Auto, and **space**
  includes it or leaves it out (`AGENT_AUTO_PROVIDERS`). Type to search the
  providers by name.
  - While Auto includes nothing, it says so: choosing it is refused, and a
    message is answered with the chat's own provider, with a warning.
  - When you choose one provider, a run may still move tasks to another,
    but only to one that Auto includes.
- **The side panel in Auto** shows each provider Auto includes: a plan's
  usage windows, or an API key's free requests and credit limit. Only calls
  that spend nothing are used, read at most once a minute. A provider whose
  API does not report usage (Gemini) says so.
- **Keys are checked before they are kept.** `grafeno-agent login gemini`
  and `grafeno-agent login openrouter` ask the provider about the key with
  a call that spends nothing: Gemini lists models, OpenRouter reads the
  key's own record (its credits, and today's free requests). A refused key
  is not kept. A key set in an environment variable is checked the same
  way whenever the provider's status is read.
- **OpenRouter** uses free models only by default: models ending in
  `:free`, or `openrouter/free`, which picks a free model with tools.
  - A paid model is refused before any request, and no fallback list is
    ever sent, so nothing can be billed.
  - `OPENROUTER_MODELS=all` allows paid models. They bill per token, so
    they run only with `AGENT_ALLOW_BILLING=openrouter`.
  - `/usage` shows today's free requests and the key's credit limit.
  - Free models' providers may keep prompts: see OpenRouter's privacy
    settings.

- **Sign-in stays with each provider.** Claude and Codex sign in with their
  own programs (`claude` /login, `codex login`); the agent never reads or
  reuses their credentials. Gemini takes your AI Studio key:
  `grafeno-agent login gemini` checks it with a call that spends nothing and
  keeps it in the system's secure store (DPAPI on Windows, the Secret
  Service on Linux, the Keychain on macOS) or reads `GEMINI_API_KEY`
  (`OPENROUTER_API_KEY` for OpenRouter). No key
  is ever stored in Grafeno, the settings file or a log, and commands the
  agent runs never see these variables. A consumer Google sign-in, or
  Antigravity's `agy`, is never used: Google's terms forbid it in
  third-party tools.
- **Three ways of paying, kept apart:** a subscription's quota (Claude,
  ChatGPT), an API's free quota (a Gemini key you declare `free`,
  OpenRouter's free models), and billing by consumption (a paid or
  undeclared Gemini key, OpenRouter's paid models, or Claude Code or Codex
  signed in with an API key). A provider that bills by consumption is
  used only if `AGENT_ALLOW_BILLING` names it, never as a fallback.
- **Quick answers:** each provider's status and plan usage are reused for a
  minute, across the agent's processes; `/usage` says how old the reading
  is, and `/usage refresh` asks again. Google's API does not report a
  key's quota, so Gemini shows none.

- **`/connect`** shows each provider (installed, signed in, plan) and
  chooses the one the chat uses; the conversation goes on with it.
  `/models` lists that provider's models, starting with **Auto** (its own
  choice). `/usage` shows each one's plan.
- **Auto**, the default (`AGENT_PROVIDERS=auto`, or nothing set; `/connect` too), uses every ready
  provider. Before each message a light model decides whether to answer
  directly or to plan the request across providers. A question never
  starts several workers.
- In a run, each task kind goes first to the provider and tier its role
  needs (`AGENT_AFFINITY`), each plan's limit is never passed, and ties go
  to the one with the most room. A provider that hits its limit or loses
  its sign-in is set aside, and its tasks go to another, unless a task has
  a merge in flight.

The default affinities:

| Task kind              | Goes first to     |
| ---------------------- | ----------------- |
| architecture, planning | Claude, standard  |
| review, backend, debug | Claude, deep      |
| docs                   | Codex, light      |
| tests, refactor        | Codex, standard   |
| frontend               | the one with room |

```bash
grafeno-agent run "orders API, UI, tests and docs" --providers auto
grafeno-agent run "..." --providers claude-code,codex --provider-for docs=codex
AGENT_AFFINITY="review=codex:deep,docs=none" grafeno-agent run "..." --providers auto
```

`--providers` lists the providers in order of preference, or `auto`.
`--provider-for kind=provider` sends a kind of task to one of them.
`AGENT_AFFINITY` takes `kind=provider[:tier]` pairs, or `kind=none`.

### The router learns

Every run leaves its attempts and outcomes in `metrics.db`, in the agent's
data folder, for all your projects. Only numbers, ids and categories are
kept: no text. `grafeno-agent router` shows what has been learned. For
each kind of task and complexity, and each provider, model and effort, it
gives how often the task succeeded cleanly (with its 95% interval), its
cost and its time, and whether the sample is big enough to count.
`--import` first reads the runs kept so far.

The router always says what it would choose. It uses a learned choice
only when the evidence is there:

- at least 10 tasks on each side;
- the same provider as your affinities chose;
- as good and cheaper, or clearly better.

The run's report says when that happened.

| Setting                | Default   | What                                                                                                                                                         |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_ROUTER`         | `learned` | `learned`, `shadow` (records what it would choose, never uses it) or `rules` (no learning)                                                                   |
| `AGENT_ROUTER_EXPLORE` | `false`   | `true`: 1 in 10 docs and tests tasks of low complexity try a less-sampled model of the same or a cheaper tier, on the same provider, recorded as exploration |

Exploration is off by default: the router learns only from what runs
anyway and spends nothing extra to learn.

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
