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

**From npm:**

```bash
npm install -g @grafenodb/agent-cli
```

**From the latest GitHub release**, the same package:

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
@grafenodb/agent-cli` removes the command.

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
uninstall -g @grafenodb/agent-cli` removes the command.

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
     grafeno keys create grafeno-agent --grant 'grafeno-agent*:admin' --config grafeno.toml
     ```

     Admin on `grafeno-agent*` lets the agent make each project's own
     namespace (`grafeno-agent--<project>`) and drop it with the project.
     With `grafeno-agent:write` only, sessions outside a project work, but
     not those in one.

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

| Variable                    | Default                 | What                                                                                                |
| --------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `GRAFENO_MODE`              | (asked)                 | `included` (the agent's own Grafeno) or `external`; empty: asked at start                           |
| `GRAFENO_URL`               | `http://127.0.0.1:7810` | The Grafeno server, when external                                                                   |
| `GRAFENO_AGENT_KEY`         | (required)              | The agent's key                                                                                     |
| `GRAFENO_NAMESPACE`         | `grafeno-agent`         | Where the agent keeps its memory                                                                    |
| `AGENT_MODEL`               | `claude-code`           | The model (`claude-code`: your Claude subscription)                                                 |
| `CLAUDE_MODEL`              | Claude Code's own       | `haiku`, `sonnet`, `opus`, `fable` (set by `/models`)                                               |
| `AGENT_EFFORT`              | the model's own         | `low` … `max` (set by `/effort`)                                                                    |
| `AGENT_PROJECT`             | the git repository      | The project whose memory the agent uses                                                             |
| `AGENT_EMBEDDER`            | `e5-small`              | Meaning for memory (a local model), or `none`                                                       |
| `AGENT_PALACE`              | `shared`                | `shared` with other agents, or `own` (see below)                                                    |
| `AGENT_SHELL`               | system shell            | The shell for commands, with its arguments; sandboxed Windows uses `cmd.exe`                        |
| `AGENT_PROVIDERS`           | `auto`                  | `claude-code`, `codex`, `gemini`, in order; `none` first: no model for the chat (set by `/connect`) |
| `AGENT_MODE`                | `auto`                  | `auto` or `specific` (set by `/mode`; choosing a provider in `/connect` sets `specific`)            |
| `AGENT_PERMISSIONS`         | `ask`                   | `ask`, `auto` or `skip`, for the whole agent (set by `/permissions`)                                |
| `AGENT_AUTO_PROVIDERS`      | none (you choose)       | The providers Auto includes (set in `/connect` with space)                                          |
| `GEMINI_TIER`               | none                    | `free` or `paid`: your Gemini key's tier (set by `login gemini`)                                    |
| `OPENROUTER_MODELS`         | `free`                  | `free` (never billed) or `all` (set by `login openrouter`)                                          |
| `AGENT_ALLOW_BILLING`       | none                    | Providers allowed to bill by consumption, such as `claude-api`                                      |
| `PROVIDER_<NAME>_ENABLED`   | on                      | `false` switches a provider off at once (`grafeno-agent providers disable`)                         |
| `CLAUDE_API_MAX_BUDGET_USD` | none                    | The most one claude-api turn may cost                                                               |
| `AGENT_AFFINITY`            | the defaults below      | Where each task kind goes first in `auto`                                                           |
| `AGENT_ROUTING`             | `balanced`              | `economy`, `balanced` or `quality`: how eagerly runs spend the plans                                |
| `AGENT_LOCAL_ROUTING`       | `light`                 | `light`, `first` or `last`: what goes to your local models (see below)                              |
| `AGENT_LEADER`              | none                    | `provider/model` that leads orchestrated runs (set by `/leader`)                                    |
| `AGENT_LEADER_AUDIT`        | `risk`                  | `risk` (low-risk tasks are decided by their checks) or `all`                                        |
| `AGENT_CHECK_REPAIR`        | on                      | `false`: a wrong check is never judged or corrected by the plan's author                            |
| `AGENT_SANDBOX`             | `auto`                  | `auto`, `required` or `off`: Grafeno Sandbox for the agent's commands                               |
| `AGENT_SANDBOX_NETWORK`     | `auto`                  | `auto` (only to install or fetch), `always` or `never`                                              |
| `AGENT_SANDBOX_KEEP`        | `never`                 | `never`, `failed` or `always`: whether a sandbox is kept when its work ends                         |
| `AGENT_AUTO_MODELS`         | (all)                   | Each Auto provider's models: `codex:gpt-6-astra,gpt-6.1-sol` (`m` in `/connect`)                    |
| `AGENT_DELIVERY`            | `live`                  | `live` (task by task), `end` or `manual`: how runs' work reaches your folder                        |
| `AGENT_MEMORY_BUDGET`       | see [Memory](#memory)   | How much memory may reach the model                                                                 |
| `WEB_SEARCH`                | the first one set up    | `brave`, `tavily` or `searxng`: the service of `web_search`                                         |
| `BRAVE_SEARCH_API_KEY`      | none                    | A Brave Search API key, for `web_search`                                                            |
| `TAVILY_API_KEY`            | none                    | A Tavily API key, for `web_search`                                                                  |
| `SEARXNG_URL`               | none                    | Your SearXNG's address, for `web_search`                                                            |

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
| `/models`      | Choose the model, by its exact name (type to search)            |
| `/leader`      | Choose the leader of orchestrated runs (see below)              |
| `/sandbox`     | Grafeno Sandbox: status, list, inspect, stop, destroy           |
| `/effort`      | Choose how hard the model thinks (Low … Max)                    |
| `/connect`     | Connections: CLI, API key, coding plan, local; manage, list     |
| `/mode`        | Auto, or the provider chosen in `/connect` (`auto`, `specific`) |
| `/palace`      | Grafeno: included, or a server you already have                 |
| `/permissions` | Ask, automatic or skip permissions, and for what (see below)    |
| `/unattended`  | Work on alone until the task is done (see below)                |
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

**The mouse does what the commands do.** Every click has a command or a
key that does the same, so nothing needs the mouse:

- the **menu bar** under the header: `[Projects]` `[New]` `[Sessions]`
  `[Model]` `[Effort]` `[Provider]` `[Permissions]` `[Memory]` `[Runs]`
  `[Agents]` `[Usage]` `[Help]`, each the command of its name. The menu
  open shows pressed: click it again to close it, or another one to move to
  it. While the agent works, the buttons that only look (Agents, Runs,
  Usage, Permissions, Help) stay on;
- **Esc** closes the menu open, or goes back from a sub-agent to the
  orchestrator; it interrupts the work only from the conversation;
- **lists** (models, efforts, sessions to resume, runs, permissions, the
  plan to run): click a row to choose it, `esc cancel` to leave;
- the **commands offered** as you type `/`: click one to run it;
- the **agents panel**: click the main agent or a sub-agent to see it;
- the **side panel**: click Model, the plan's usage or Memory to open
  `/models`, `/usage refresh` or `/palace`;
- **`/connect`**: click a provider to use it, its `[in Auto]` mark to
  include it or leave it out, its `models:` to choose them, and Auto;
- a **permission request**: its `y allow` and `n don't allow` buttons.

It needs a terminal that reports the mouse (most do).
`GRAFENO_AGENT_MOUSE=off` leaves the mouse to the terminal: then clicks and
the wheel do nothing here, and selecting text needs no Shift.

**Conversations** are kept per project. `[Sessions]` (or `/resume`) lists
the earlier ones: Enter or a click takes one up again; **d** or its
`[delete]` deletes it, after asking (it cannot be undone; what the agent
stored in its memory stays). Without the interface:
`grafeno-agent sessions` and `grafeno-agent sessions delete <id>`.

**Projects.** `[Projects]` (or `/projects`) lists your projects, each a
name and a folder: open one, and a new session starts in its folder, with
its own conversations (`/resume`), runs and memory. **+ New project** asks
a name and a folder (made when it does not exist, with a git repository);
**+ Add this folder** lists the folder you are in. Without the interface:
`grafeno-agent projects`, `projects add <folder> [--name n]`,
`projects new <folder>`, `projects remove <name>`. The list is
`projects.json`, next to the settings.

**Each project has its own memory.** Every session opened in a project's
folder (or one inside it) reads and writes the project's own namespace in
Grafeno, `grafeno-agent--<project>`: several sessions at once share what
each one learns. The namespace is made by the project's first session.
Sessions outside any project share one namespace of their own,
`GRAFENO_NAMESPACE` (`grafeno-agent`). **− Delete a project** (in
`[Projects]`, or `grafeno-agent projects remove <name>`) asks first, then
drops the project's namespace with everything in it, its conversations
and its runs, so nothing is left behind; its folder, with your code,
stays. If the namespace cannot be dropped, nothing else is deleted. With
the included Grafeno, the agent's key is remade once with the rights this
needs; with another server, see the key above.

**Long work goes on by itself.** A turn that reaches its step limit (40
model requests) carries on in the same conversation, up to ten rounds,
instead of stopping; only then does it pause and say so. A sub-agent has
six rounds per attempt, and one that spends 8% or more of its provider's
window and is not done moves, between rounds, to a lighter model, which
takes over from its progress so far (in economy and balanced; never for
models you chose, nor for the hardest tasks).

**The conversation** shows each action while it runs: what it does (Read,
Edit, Run, Search, Recall…), on what, and what came of it (120 lines, ok,
exit 1, 3 matches, not allowed: …). Once done, the actions in a row fold
into one line, such as `✓ Read 3 files, edited a file, ran 2 commands ▸`.
A click on it unfolds the group: each action and what it did (a change as
`-` and `+` lines, a command's output, an error). **ctrl+o** unfolds or
folds every group at once, in a sub-agent's view too. A turn that did
something closes with a line of its result (`✓ Worked for 1m 12s · edited
2 files, ran 3 commands`), and the agent ends its answer with what was done
and how it turned out. The agent's answers come under ◆ Grafeno Agent;
code comes framed, with its language, and diffs in their colours.

**A run's result.** When a plan of sub-agents ends, **Result** says how
many tasks were done and, for each, what its sub-agent did or why it did
not, then where the work is (merged into your branch, or the branch to
merge). The technical details (attempts, tokens, models, what the
sub-agents asked) stay folded under **Run details**: a click or ctrl+o
opens them.

**The agents panel** draws the sub-agents as a tree under the orchestrator:
each one's task as its title, the model it uses under it, and what it is
doing (waiting, thinking, the tool it runs, done).

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
| `read_document` (PDF, Word, Excel, PowerPoint, OpenDocument)   | runs freely                                                   |
| `environment_info` (system, shell, branch, programs installed) | runs freely                                                   |
| `write_file`, `edit_file`, `multi_edit`                        | asks you, showing the change                                  |
| `move_file`, `delete_file` (a file or an empty folder)         | asks you                                                      |
| `run_command`                                                  | runs freely when it only reads (`git status`…); else asks you |
| `start_process` (a dev server or a watcher, in the background) | asks you                                                      |
| `process_output`, `list_processes`, `stop_process`             | run freely (only the agent's own processes)                   |
| `local_http` (a server on this computer: localhost)            | GET and HEAD run freely; other methods ask you                |
| `web_fetch` (a web page, or a PDF on the web)                  | asks you                                                      |
| `web_search` (with your search service: see below)             | asks you                                                      |
| memory tools (from Grafeno's MCP server)                       | run freely (the memory is the agent's own)                    |
| plugin tools (GitHub, GitLab: see below)                       | reading runs freely; anything that changes something asks you |

**Documents.** `read_document` reads the text of PDF, Word (`.docx`),
Excel (`.xlsx`), PowerPoint (`.pptx`) and OpenDocument (`.odt`, `.ods`,
`.odp`) files, on this computer, without other programs: PDFs by page,
decks by slide (with their notes), workbooks by sheet (cell values, tab
separated); `pages` reads a part of a long one. Scanned PDFs (images of
text) and the old `.doc`, `.xls`, `.ppt` formats are not read.

**Images.** `read_file` shows the model an image of the project (PNG,
JPEG, GIF, WebP, up to 5 MB): a screenshot, a diagram, a mock-up. Claude
(through Claude Code), Gemini and the vision models of OpenRouter see it;
whether Codex does depends on its version; a model that cannot see images
gets only the line about it, and says so.

**Web search.** `web_search` searches with a service you set up in the
settings file: a Brave Search API key (`BRAVE_SEARCH_API_KEY`), a Tavily
API key (`TAVILY_API_KEY`), or the address of your own SearXNG
(`SEARXNG_URL`, with its json format allowed). With more than one,
`WEB_SEARCH` chooses. Without one, the agent tells you it cannot search.
`grafeno-agent check` shows which is in use. It returns titles, addresses
and snippets; `web_fetch` then reads a page.

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

### Grafeno Sandbox

The agent's commands (`run_command`, `start_process`, a run's checks) run
in **Grafeno Sandbox**, made and destroyed by the agent, installed with it:
no Docker or other engine, no daemon.

- **Linux**: a native helper in the package (namespaces, Landlock,
  seccomp, cgroups v2 or resource limits, whatever the kernel allows an
  unprivileged user). The command reads only the system, its programs and
  the project; writes only the project and its own home and temp; gets no
  network unless it installs or fetches.
- **macOS**: `sandbox-exec`, with a profile per command.
- **Windows**: a native helper in the package launches each command in an
  AppContainer (files, processes and network) and owns its process tree in
  a Job Object (memory, CPU and process limits).

Each command's result says what isolated it (`sandboxed (files closed
off, no network, own processes, limits)`), never more than was applied.
`AGENT_SANDBOX=required` refuses a command that cannot be sandboxed;
`off` turns it off. `/sandbox status` says what this computer has and what
it lacks; `/sandbox list`, `inspect`, `stop`, `destroy`, `cleanup` manage
the sandboxes. Details, policies and the limitations of each platform:
[docs/sandbox.md](docs/sandbox.md).

### Permissions

`/permissions` chooses how the calls that would ask you are decided:

| Mode                 | What happens                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask** (default)    | You are asked, as in the table above.                                                                                                                                                                                                                                                 |
| **Automatic**        | The agent decides by the call's risk, in code: changes to the project's files, checks, builds, `git add` / `commit`, local servers and reading the web run; deleting, pushing, publishing, installing programs, commands it cannot tell are safe, plugins and external MCP tools ask. |
| **Skip permissions** | Nothing is asked: every such call runs.                                                                                                                                                                                                                                               |

Then for what:

- **The whole agent**: every session and sub-agent from now on
  (`AGENT_PERMISSIONS` in the settings);
- **This session**: only this conversation, until it ends;
- **This session and its sub-agents**: this conversation and the runs it
  starts.

In every mode, what is never allowed stays so (the list above). The footer
says when permissions are not **Ask**. `grafeno-agent run` takes
`--permissions ask|auto|skip` for a run's workers.

### Unattended operation

`/unattended` (or `/unattended on` / `off`) is for work nobody watches:

- the session and its sub-agents run with permissions skipped;
- plans run without being confirmed: the main agent's, `/orchestrate`'s
  and Auto's;
- runs go on in **extended** mode: they retry what fails, replan on their
  own (twice at most) and merge into your branch when every check passes;
- the model is told on each message that nobody is watching: it decides,
  keeps working until the task is done, and reports at the end, instead of
  asking you.

So it can change code, commit, push to GitHub, install programs with
`winget`, `npm -g` or `pip`, and retry failures, on its own. What is never
allowed stays so: forced pushes, raised privileges (`sudo`, so system
package managers that need it), deleting everything, piping code from the
internet into a shell, secrets. The footer shows **UNATTENDED** while it
is on; `/permissions` or `/unattended off` ends it. Without the interface:

```bash
grafeno-agent run "add the orders API with tests and push it" --unattended
```

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

- each task works in its own **git worktree and branch**, a copy of the
  project under `%LOCALAPPDATA%\grafeno-agent\worktrees\<project>\<run>\<task>`
  (`~/.local/state/grafeno-agent/worktrees/…` elsewhere), so workers running
  at once never step on each other or on your uncommitted work; the run
  says where when it starts;
- each worker gets the model and effort its task needs (architecture and
  hard backend work on the deepest model, tests and docs on the lightest),
  checked against what your provider really offers and how much of your plan
  is used;
- workers share memory through Grafeno: decisions of the tasks they build
  on reach them, with who made them;
- a task is done only when its **checks pass, run by code** (its tests,
  typecheck, build or files); a failed check goes back to its worker;
- finished tasks are merged into the run's **integration branch**
  (`grafeno/<run>/integration`), and from it **into your folder, task by
  task** (`AGENT_DELIVERY=live`, the default): each task's work lands on
  the branch you are on as a merge commit as soon as its checks pass, so you
  see the work grow. At the end, every task's checks run together on your
  branch; if any fails, the run's merges are undone (`git reset --keep` to
  where your branch was before the run). Changes of yours are kept safe:
  git refuses a merge that would overwrite them, and a task not brought in
  is tried again with the next one and at the end; staged files hold it
  until you commit or unstage them. Nothing is ever pushed.
  `AGENT_DELIVERY=end` brings everything in only when the run completes;
  `manual`, never (you merge the integration branch yourself).

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

### A leader for the run

`/leader` chooses one model of one of Auto's providers (searched by name)
to **lead** orchestrated runs, `/orchestrate` and the sub-agents the agent
starts. The leader:

1. **plans** the run, as the planner would, and **gives each task to a
   sub-agent**: a provider, and a model of it (`"assign":
"codex/gpt-6-mini"`). The router follows its choice when that provider
   is ready and has room, and says so (`the leader gave it to …`);
   otherwise the usual rules decide. A local model gets only tasks it can
   do with tools.
2. **decides** the sub-agents' requests for more work.
3. **audits every task**, docs too, once its checks pass: it **approves**
   it, or **sends it back** with what to fix (up to three times; then a
   person decides). Its approval is needed besides the checks, never
   instead of them: a task whose checks fail never reaches it. It is told
   what the sub-agent says it did, and sees the change.
4. **leaves suggestions** for the sub-agents after: what it suggests when
   it approves a task reaches the tasks that depend on it, under "The
   run's leader suggests".

The plan says who leads (`Leader: claude-code/opus · planned it, gave out
the tasks, and audits each one`), and the run's **Result** says what it
approved, what it sent back and how many suggestions it left. A leader
whose provider is not one of the run's is said in the plan, and the run
goes on without one. `AGENT_LEADER` keeps the choice (`provider/model`, or
a provider alone for its own choice of model); `grafeno-agent orchestrate
--leader provider/model` sets it for one run.

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
the tool it runs, done, waiting for a person). The **right panel follows
the agent on screen**: on the main agent, its model, context and your
plans' usage (all of Auto's providers in Auto); on a sub-agent, that
sub-agent's own task and state, its provider, model, tier and effort, the
tokens it spent, how full its context is, how long it has worked, its
folder and branch, and the last thing it told the orchestrator.

**Sub-agents and the orchestrator talk as the run goes:**

- each sub-agent reports at its milestones (`report_progress`): what it
  found, did, or ran into. It shows on the screen as it comes, and the main
  agent gets all of it with the run's report;
- a sub-agent that needs work it cannot do alone asks for it
  (`request_work`): a finished task done again (its own or another one,
  whose result fell short or must be redone), or a task the plan lacks.
  The orchestrator decides, with the planner's model, after code has
  refused what makes no sense (a task that does not exist, one still to
  run, one still running). If it rejects, the sub-agent gets the reason and
  goes on with its task. If it accepts, the work becomes a task of the plan
  (`<task>-again-2` for a rerun, `<task>-more-2` for a new one), whose
  description says who asked, why, and what to do, and a sub-agent does it
  as any other task. A run accepts four requests at most.

- **Ctrl+N / Ctrl+P**, or `/agents`, show another agent's work as it goes:
  its words and the tools it used.
- A sub-agent is **read only**: it takes no prompts, because the main agent
  orchestrates it. Go back to the main agent to write.
- The panel shows when the window is wide enough (140 columns with the
  right panel, 100 without: Ctrl+B hides it). The keys and `/agents` work
  in any width.

### Several providers

Besides Claude Code, the agent can reason with **Codex CLI**, OpenAI's
official CLI, signed in with your ChatGPT subscription; with **claude-api**,
Claude through the official Claude Agent SDK and an Anthropic API key; and
with **Gemini** (Google AI Studio) and **OpenRouter**, each with your own API
key.

A **vendor** (Anthropic, OpenAI, Moonshot…) may have several
**connections**, one per way to reach it, and a connection offers models.
`/connect` opens on how to connect:

1. **CLI / Subscription**: the vendors' official programs on this
   computer, signed in their own way. Each is checked for real: its
   `--version`, and a session opened (spends nothing). A program that is
   only installed is never shown as connected.
2. **API Key**: the vendors' official APIs, with your key. It is typed in
   a masked field, checked with the vendor for free when its API can be,
   and kept in the system's secure store. They bill per token, so each is
   used only once you allow it.
3. **Coding Plan**: a membership or prepaid plan's own key, which is not an
   API key and works only on the plan's endpoint. The vendors' terms limit
   these keys to the coding tools they list, or do not say, so each starts
   **off**.
4. **Local models / Self-hosted**: model servers of your own, on this
   computer or another of yours (see below). No key unless the server asks
   for one.
5. **Manage connections**: switch one on or off, check it, set or change
   its key, disconnect it, allow or forbid per-token billing.
6. **View connections**: every connection and its state.

Every choice can be clicked, chosen with its number, or reached with
`/connect cli`, `/connect api`, `/connect plans`, `/connect local`,
`/connect list`, `/connect status` (with each one's detail),
`/connect manage` and `/connect disconnect <connection>`. **Esc goes back
one step** (a section to this menu, a step to the one before); at the
menu, it closes `/connect`.

In a section, each connection shows its name and a ✓ or ✗; what its
status says (installed, signed in, plan, how to sign in) is folded:
**→** opens the selected one's, **←** folds it, **Tab** opens or folds them
all. The first run shows them all.

**Mode: Auto or specific.** `/mode` switches **Auto** on or off, by hand
(`AGENT_MODE=auto` or `specific`): Auto triages each message across the
providers it includes (marked in `/connect` with space); **specific** uses
the provider chosen in `/connect`. Choosing a provider in `/connect`
switches to specific at once; it never switches Auto on. Switching Auto
off finds the provider chosen before again.

**No model.** In a section, **No model** chooses none for the chat:
nothing is sent to any provider from it, and each message is refused with
a line saying how to choose one. It is the chat's choice alone: the other
connections stay on, for runs and for when you choose one again. To keep a
connection from being used at all, switch it off in **Manage
connections**. The chat also starts with no model, said as such, when the
one you chose is switched off: it never moves to the next one in the list
behind your back.

**Off means off.** A connection switched off (in **Manage connections**,
or `grafeno-agent providers disable`) is never used: not by the chat,
whose conversation with it ends at the next message (the chat is left with
no model at once when it was the one in use), not by Auto or a run, not by
a model started before it was switched off. It stays listed, and its key
stays kept, until you switch it on again.

| Vendor             | CLI / Subscription                   | API Key      | Coding Plan          |
| ------------------ | ------------------------------------ | ------------ | -------------------- |
| Anthropic          | `claude-code-local` (Claude Code)    | `claude-api` | —                    |
| OpenAI             | `codex` (Codex CLI, ChatGPT sign-in) | `openai`     | —                    |
| GitHub             | `copilot` (Copilot CLI, over ACP)    | —            | —                    |
| Alibaba (Qwen)     | `qwen-code` (Qwen Code, over ACP)    | `qwen`       | `qwen-plan` (off)    |
| Moonshot AI (Kimi) | `kimi-code` (Kimi Code, over ACP)    | `moonshot`   | `kimi-plan` (off)    |
| Mistral AI         | `mistral-vibe` (Vibe, over ACP)      | `mistral`    | —                    |
| Google             | — (not offered: Google's terms)      | `gemini`     | —                    |
| DeepSeek           | — (no official CLI)                  | `deepseek`   | —                    |
| Z.ai (GLM)         | —                                    | `zai`        | `zai-plan` (off)     |
| MiniMax            | —                                    | `minimax`    | `minimax-plan` (off) |
| xAI (Grok)         | —                                    | `xai`        | —                    |
| OpenRouter         | —                                    | `openrouter` | —                    |

The CLIs marked "over ACP" are driven through the Agent Client Protocol,
the interface their vendors document for editors and scripts.

```bash
grafeno-agent providers                       # each: sign-in, on/off, ready or why not
grafeno-agent providers disable claude-code-local
grafeno-agent providers enable claude-code-local
grafeno-agent providers install claude-api    # the Claude Agent SDK, pinned (about 335 MB unpacked)
grafeno-agent login claude-api                # its API key, checked; asks before allowing billing
grafeno-agent login deepseek                  # any connection by key: checked, kept in the secure store
grafeno-agent logout deepseek                 # disconnect: its key is removed
```

- **claude-code-local** (`claude-code` in older settings) runs the official,
  unmodified `claude` program with documented options (`claude -p`), signed
  in its own way. The agent never reads, keeps or reuses its credentials,
  and it starts it without `ANTHROPIC_API_KEY`, so it can never switch to
  per-token billing on its own. **Using a Pro or Max subscription this way,
  inside a third-party orchestrator, awaits clarification from Anthropic.**
  It is on for now as a project setting. That is not an approval or a
  certification by Anthropic. Do not use it as a shared backend or a hosted
  service for others. `grafeno-agent providers disable claude-code-local`
  (`PROVIDER_CLAUDE_CODE_LOCAL_ENABLED=false`) turns it off at once,
  without touching the other providers.
- **claude-api** uses the official Claude Agent SDK with an Anthropic API
  key only, never a Claude subscription's sign-in. Each turn checks that
  the SDK signed in with the key, and stops otherwise.
  - Its process gets a private configuration folder, and none of your other
    keys. Its built-in tools are off: only the agent's tools reach it, over
    MCP, with the agent's permissions.
  - It bills per token. It runs only when `AGENT_ALLOW_BILLING` includes
    it, which `login claude-api` asks about.
  - It reports each turn's cost, and `CLAUDE_API_MAX_BUDGET_USD` caps it.
  - Without the SDK or a valid key it says it is not available, and the
    other providers go on.
- **codex** runs the official `codex exec --json`, OpenAI's documented
  non-interactive mode, which reuses the CLI's own Sign in with ChatGPT.
  It is started without `CODEX_API_KEY` or `OPENAI_API_KEY`, so it never
  switches to the API. Its plan's usage is read through the documented
  app-server (`account/rateLimits/read`). A rate-limit reset credit is
  never spent.

### Local models and self-hosted servers

The agent reasons with models you run yourself, too:

| Server                | How the agent talks to it                                        | Default address            | Key                    |
| --------------------- | ---------------------------------------------------------------- | -------------------------- | ---------------------- |
| **Ollama**            | its own HTTP API (`/api/chat`, streamed), so it sets the context | `http://localhost:11434`   | none                   |
| **LM Studio**         | its OpenAI-compatible API (`/v1`, streamed); also headless       | `http://localhost:1234/v1` | only if you turn it on |
| **Bionic**            | its OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`) | your server's address      | yes (made in Bionic)   |
| **OpenAI-compatible** | any server with `/v1/models` and `/v1/chat/completions`          | your server's address      | only if it asks        |

In **`/connect` → 4. Local models / Self-hosted**, choose **+ Ollama**,
**+ LM Studio**, **+ Bionic** or **+ Custom OpenAI-compatible endpoint**:

1. **Its address**, proposed when the server has a documented one. It is
   checked before anything is kept: http or https only, no user or
   password in it, and never a link-local address (169.254.x.x, fe80::,
   where clouds answer with their machines' secrets) nor `0.0.0.0`. Its
   name is resolved to see where it really leads.
2. **Its key**, only when the server asks for one (or Bionic, which always
   does). It is typed masked, checked, and kept in the system's secure
   store. A key is never sent in the clear to another machine: off this
   computer, the address must be https.
3. **Its default model**, among those the server lists, each with what it
   can do: whether it takes tools, sees images, its context, and whether
   it is loaded.

Several connections of the same kind can be kept (`ollama`, `ollama-2`,
`gpu-box`…). Choosing one in the list checks it again, changes its model,
address or key, or removes it; its first action, **Use it for the chat**,
makes it the chat's model (its default model, else a loaded one that
takes tools). **Use a connection** opens them all as providers: Enter uses
one for the chat, space puts it in Auto, **m** chooses its models there.

**Tools.** A local model that takes tools gets the same ones as any other:
the project's files and commands, Grafeno's memory tools, skills, and the
tools of the MCP servers you added (`/mcp`), as function calls over the
server's API, with the same permissions. A model known not to take tools
gets none.

**What is checked, never assumed.** Each model's capabilities come from
the server: Ollama's `/api/show` (tools, vision, thinking, context), LM
Studio's `/api/v1/models` (tool use, vision, loaded context; older
versions' `/api/v0/models`, then `/v1/models`). Bionic and other
OpenAI-compatible servers list only names, so their models' tools and
context are **unknown**, and an unknown capability counts as missing:

- a model known not to take tools is offered none (it only answers);
- a local model takes tasks done with tools (files, commands) only when
  it is known to take tools and runs with at least 16k tokens of context;
- Ollama runs the model with the context you set, else what the model
  takes, up to 32k (`num_ctx`).

**Routing.** In Auto, a capable local model is preferred where it is
enough: simple tasks (light tier, or complexity 1–2) and sorting requests
(the triage) go to it first. Harder tasks go first to your subscriptions
and free quotas, then to local models, and never to an API billed per
token unless you allowed it. A server that took over 30 seconds to answer
is not preferred. `AGENT_LOCAL_ROUTING=first` sends it every task it can
take; `last`, only what nothing else can.

**Usage.** A local or self-hosted server has no quota or credits: the side
panel and `/usage` show only the tokens it used.

**Privacy.** A model on this computer keeps your prompts on this computer.
The agent only connects to servers you name; it never opens or exposes
one, and never logs prompts or keys. Lists say where each server is: on
this computer, on your network, or self-hosted outside it.

From a terminal:

```bash
grafeno-agent local                                   # the connections
grafeno-agent local add ollama                        # at its documented address, checked
grafeno-agent local add lmstudio http://192.168.1.20:1234/v1 --id studio-box
grafeno-agent local add bionic https://ai.example.com/v1 --key-env BIONIC_API_KEY --model llama-3.3-70b
grafeno-agent local add openai-compatible http://localhost:8080/v1 --id llamacpp
grafeno-agent local check ollama                      # its models and what each can do
grafeno-agent local model ollama qwen3:8b             # its default model
grafeno-agent local remove studio-box
```

A key is never given on the command line (it would stay in the shell's
history): `--key-env` names the variable that holds it. The connections
are kept in `local-connections.json`, next to the settings, without keys:

```json
{
  "connections": [
    {
      "id": "ollama",
      "kind": "ollama",
      "name": "Ollama",
      "url": "http://localhost:11434",
      "defaultModel": "qwen3:8b",
      "inference": { "contextLength": 32768, "temperature": 0.2, "keepAlive": "10m" }
    },
    {
      "id": "bionic",
      "kind": "bionic",
      "name": "Bionic",
      "url": "https://ai.example.com/v1",
      "hasKey": true,
      "timeoutMs": 300000
    }
  ]
}
```

`inference` takes `temperature`, `contextLength`, `maxTokens` and, for
Ollama, `keepAlive`; `timeoutMs` is the longest one request may take
(default ten minutes).

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
- **Auto**, the default (`AGENT_MODE=auto`, or nothing set; switched on and off in `/mode`), uses every ready
  provider. Before each message a light model decides whether to answer
  directly or to plan the request across providers. A question never
  starts several workers.
- In a run, each task kind goes first to the provider and tier its role
  needs (`AGENT_AFFINITY`), each plan's limit is never passed, and ties go
  to the one with the most room. A provider that hits its limit or loses
  its sign-in is set aside, and its tasks go to another, unless a task has
  a merge in flight. A provider that took most of a run's tasks yields to
  another with room.
- **The minimum sufficient model.** In `economy` and `balanced`, each
  attempt runs on the cheapest model and effort likely enough to pass the
  task's checks: a stated prior per class of model and complexity,
  corrected by what each model was seen to do (checks run by code, the
  environment's failures never held against it), with the cost of retries
  and escalations counted in. A failed attempt is retried once with the
  checks' diagnostic, then escalated; a task stops at a quarter of a
  window. Every decision is kept with its candidates and why each was left
  out: `grafeno-agent router --decisions <run>`. `docs/routing.md` says how
  it decides, how it was checked (a simulation: `npm run eval:routing`) and
  what is open.
- **How eagerly plans are spent** (`AGENT_ROUTING`):
  - `balanced` (the default): the deep tier and high efforts only for hard
    tasks (complexity 4–5), even when the planner asks for more; from half
    of any window (5 hours or the week) one effort lower, from 70% a tier
    lighter, at 95% the run waits for the reset;
  - `economy`: the lightest that can do the task;
  - `quality`: the planner's and the profiles' choice, lighter only from 80%.
- **What each model spends is learned and kept.** Each attempt measures the
  share of its provider's window it took (its part of what the provider
  served meanwhile, when attempts run at once). The measurements are kept
  in the metrics across sessions and projects, and grow as a run goes: a
  model and effort seen to take 8% or more of a window per task (two tasks
  are enough) is kept off tasks that are not hard, one effort lower first,
  then the lighter tier's model. The run's events say why each choice was
  made.
- **Each provider's models in Auto.** In `/connect`, **m** on a provider in
  Auto chooses its models: **Auto** (every model, chosen by the task and by
  what each spends), or the ones you mark (`AGENT_AUTO_MODELS`). Chosen
  models are used because you want them: hard tasks still go to the
  strongest of them and simple ones to the lightest, but they are never
  swapped by usage or cost. The plan's 95% hold still applies.

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

| Setting                | Default   | What                                                                                                                  |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENT_ROUTER`         | `learned` | `learned`, `shadow` (records what it would choose, never uses it) or `rules` (no learning)                            |
| `AGENT_ROUTER_EXPLORE` | `0.1`     | The share of low-risk tasks that may try a cheaper arm with little evidence (at most 2 per run); `false` turns it off |
| `AGENT_LEADER_AUDIT`   | `risk`    | `risk`: the leader audits every task but the low-risk ones, which their checks decide; `all`: every task              |

### How a model is chosen

Each task gets the **minimum sufficient** model: the arm (provider, model
and effort) with the lowest expected cost of the whole execution (its
first attempt, and the retries and escalations a failure would bring)
among those likely enough to pass the task's checks for its risk. The
order of authority is fixed:

1. what the task must have (tools, safety) and what is ready (signed in,
   with room, allowed to bill);
2. your own choices (a provider for a kind of task, the models you chose
   for Auto): kept as you chose them;
3. limits and budgets (a window filling up, a task's share of a plan);
4. the router's choice, from evidence;
5. the leader's recommendation and the affinities: **preferences**, never
   pins. A leader's model is followed when it is sufficient and costs about
   the same (within 10%) as the cheapest sufficient one; otherwise the
   decision records what it recommended, what was chosen, and why.

**What is known of each arm** is said with its decision: `unknown` (no
attempt: the prior, an assumption, stands in), `exploring` (fewer than 4
attempts), `provisional`, `established` (10 or more) or `degraded` (even
its best plausible rate is under the floor). No attempts is never read as
incapacity, and a stronger model never wins by its higher prior alone.

**Failures are told apart** (capability, verification, context, tools,
infrastructure, sign-in, quota, ambiguous): only capability, verification
and context count against a model. Failed checks are retried once on the
same arm with their diagnostic; then the task climbs one rung (more effort
before a stronger model), at most twice; quota moves it to another
provider or waits, never to a stronger model.

**Checks can be wrong too.** The plan's checks are written by a model.
When a check fails in a telling way (its own command broke: a syntax
error, an operator read as a file; or the same check failed the same way
again after the worker had its diagnostic), whoever wrote the plan (the
leader, else the planner's model) is shown the checks, what they said and
the change, and says which is wrong. Corrected checks are read with the
plan's rules (forbidden commands refused, a placeholder or a check that
passes whatever the work is refused) and run on the same work at once;
they replace the old ones unless they cannot even run (a broken command,
a script that does not exist). A worker that did the work is not sent
back. At most 2 judgements
per task; the old and new checks are recorded with the run and shown in
its result. `AGENT_CHECK_REPAIR=false` turns it off.

**Exploration** keeps evidence from coming only from what was already
chosen: on a low-risk task, now and then (10%, at most 2 per run), a
cheaper arm with little evidence that a few early failures set aside is
tried, recorded as such, with an escalation behind it if it fails.

`grafeno-agent router` explains it: what each kind of task spent
(measured where the provider measured, `unknown` otherwise, never zero),
what was explored, the failures by kind, which arms are still too little
tried; `--decisions <run>` shows each decision, its candidates, the
leader's recommendation and whether it was followed.

`npm run eval:routing` compares the policies on a simulation (an assumed
truth, not real models): it shows how they behave, not how much a real
run saves.

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

| Message                                           | What to do                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `GRAFENO_AGENT_KEY is not set`                    | `grafeno-agent init`, then put the key in the settings file           |
| `Grafeno does not answer at …`                    | Start the Grafeno server (on Windows, the service `grafeno`)          |
| `Grafeno refused the agent's key`                 | The key is wrong, revoked or expired: ask for a new one               |
| `The agent's key may not use namespace …`         | The key needs `--grant <namespace>:write`, or set `GRAFENO_NAMESPACE` |
| `… may not make or use the project's namespace …` | Projects need `--grant '<namespace>*:admin'` on the agent's key       |
| `Claude Code was not found` / `is not signed in`  | Install Claude Code, run `claude`, sign in with `/login`              |
| `The Claude plan's usage limit is reached`        | Wait until the time it says; the agent does not work around it        |

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
