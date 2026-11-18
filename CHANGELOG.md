# Changelog

## Unreleased

- **A long answer is drawn a few times, not once per fragment**: what
  streams in is drawn at most every 40 ms (1000 fragments: well under 250
  frames, none lost).
- **`NO_COLOR`** turns the interface's colors off (its terminal library
  reads only `FORCE_COLOR`; the CLI tells it before it loads).
- In a narrow window the status bar says the keys short (`ctrl+p · ctrl+b
panel · esc`) and they come before the model on the right.
- [docs/tui.md](docs/tui.md): how the interface is built, for whoever adds
  a view.
- **Views over the conversation**, with the same keys and only what the
  system knows: `/runs` (each run's tasks and attempts: model, outcome,
  time, tokens, checks, why routed; o opens it as before), `/providers`
  (available, connected, configured, unavailable or error, from what each
  answered; use one, switch it, ask again), **Models · details** (tier,
  and context, tools, vision when a model server says so) and `/vault`
  (search the memory, a memory with its facts, the contradictions
  Grafeno recorded).
- **Delete or empty a namespace** from `/vault`: a dialog asks for its name
  typed in full; emptying deletes and makes it again with its description;
  this session's own is not deleted (it can be emptied, with a warning);
  Grafeno's `Drop` permission decides.
- Keys reached a list drawn in the same moment late: its handler was
  registered after the screen showed it, so an Enter pressed at once was
  lost. Handlers now register as they are drawn.
- **Panels take the keys**: Tab and Shift+Tab move between the
  conversation, the side panel and the agents panel; in a panel ↑↓ choose,
  Enter opens, Shift+F10 (or the Menu key, or a right click) shows the
  actions, and Inspect shows what the run recorded of an agent. Esc closes
  what opened and gives the keys back where they were.
- **Shared components** for what comes next: an inspector, a context menu
  (the same list as the others), a dialog (with a name typed in full for
  what cannot be undone), a table (sorted by column) and a tree (opened and
  closed with ←→), each with the same keys and mouse: a click selects, a
  double click opens, a right click shows the actions.
- **The layout follows the window**: the conversation, the side panel and
  the agents panel show by what each needs at its narrowest (wide, standard
  or compact), not by fixed widths; in a narrow window Ctrl+B opens the
  panel over the conversation. Ctrl+F maximizes the conversation for now;
  the palette makes a panel wider or narrower, or restores the layout; the
  choices are kept (`AGENT_TUI_LAYOUT`). The interface's frame is one
  component (`Shell`) with its regions.
- **A status bar**: who has the keys (CHAT, MENU, APPROVAL, AGENT), the
  mode, what runs without asking, a panel with no room, the keys that work
  from anywhere.
- **Colors that say what something is**: cyan for focus and the row
  chosen, violet for memory and agents, beside Grafeno's green; a mark or
  a word always says it too.
- **The interface's input, read in one place**: keys and the mouse go to
  whoever has the focus, by layer (an approval over a menu or dialog over
  the conversation), never to everyone: a key typed in a menu no longer
  reaches the prompt behind it, and PgUp/PgDn and the wheel scroll the
  menu, not the conversation. The mouse's right button and double clicks
  are recognized (for the inspectors and menus to come).
- **Ctrl+P opens the command palette**: every command and key, searchable;
  a menu button, its key, the palette and the typed command run the same
  action. Ctrl+N goes to the next agent (Ctrl+P did the previous one; Esc
  goes back to the main agent).
- **Typing ahead**: the prompt takes keys while the agent answers, and
  Enter sends once it is done; what is typed and not sent stays while a
  menu is open over it (it was lost).
- **`/mode`**: Auto, or the provider chosen in `/connect`, with its own
  setting (`AGENT_MODE`). Auto is switched on and off there, by hand;
  choosing a provider in `/connect` switches to specific at once, and
  switching Auto off finds that provider again (Auto no longer replaced
  the choice). `/connect` no longer offers Auto as a row; it still marks
  which providers Auto includes.
- **No model is the chat's alone**: it no longer leaves runs with no
  provider (`AGENT_PROVIDERS=none,…` keeps the others chosen). A
  connection is kept from being used by switching it off in Manage
  connections.
- A command typed whole is the one Enter runs: `/mode` was taken for
  `/models`, whose alias starts the same.

## 0.2.2 (2026-11-17)

- **No model at all**: `/connect` offers **No model** under Auto
  (`AGENT_PROVIDERS=none`): nothing connected is used, whatever is signed
  in, and each message is refused with a line saying how to choose one.
  The chat starts with no model, said as such, when the one chosen is
  switched off or every connection is, instead of moving to the next one
  in the list; a model that is not ready is said at start too.
- **Off means off**: a connection switched off is never used, not even by
  a conversation already open with it (checked at each message); turning
  off the one in use leaves the chat with no model at once; Auto's pool
  leaves it out at once rather than within a minute.
- **A local model as the chat's**: each local connection's actions start
  with **Use it for the chat**.
- **/connect**: each connection's status (installed, signed in…) is folded
  until asked for (→ one, Tab all; the first run shows them); Esc goes back
  one step everywhere instead of closing every menu.

## 0.2.1 (2026-11-17)

- **The leader advises, the router decides**: a leader's recommended
  provider is a preference (with room, under your own choices), and its
  model is taken only within the tier the task needs, or, with minimum
  sufficient routing, when it is sufficient and within 10% of the
  cheapest's expected cost. It never pins a model any more (only the
  models you chose for Auto are kept whatever happens); each decision
  records the recommendation, whether it was followed, and why.
- **Cold start and uncertainty**: each arm's evidence is `unknown`,
  `exploring`, `provisional`, `established` or `degraded`; no attempts is
  never read as incapacity, and priors are said to be assumptions.
- **Exploration that works**: directed, on low-risk tasks, within a budget
  (10%, at most 2 per run), reproducible with a seed; it was off and, when
  on, never reached under minimum sufficient routing. On by default now:
  `AGENT_ROUTER_EXPLORE=false` restores the old behaviour.
- **Failures told apart**: capability, verification, context, tools,
  infrastructure, sign-in, quota, ambiguous, recorded with each attempt
  (`failure_class`, a new column); at most 2 escalations per task. A
  check whose own command was broken (a syntax error, an operator read as
  a file) and a timeout in which no answer came back are held against no
  model.
- **Wrong checks are judged, not retried**: when a check's own command
  breaks, or the same check fails the same way after the worker had its
  diagnostic, the plan's author (the leader, else the planner's model)
  says whether the check or the work is wrong; corrected checks (read with
  the plan's rules, never a placeholder or one that passes anything) run
  on the same work at once and are kept unless they cannot even run, recorded with the run (`checks_judged`, `checks_repaired`) and
  shown in its result. At most 2 per task; `AGENT_CHECK_REPAIR=false`
  turns it off. A failed task's result now names the check that failed.
- **Models a local server gives no class** are not ranked by where they
  come in its list: they start with the same prior, the leader's
  recommendation breaks the tie, and after one fails the task moves
  sideways to another of the same standing.
- **The leader audits by risk** (`AGENT_LEADER_AUDIT`): low-risk tasks
  whose checks passed need no extra model call; `all` restores auditing
  every task.
- `grafeno-agent router`: spending by kind of task (unknown where not
  measured), exploration, failures by kind, arms still too little tried,
  and how often the leader was followed. `npm run eval:routing` compares
  the leader's pin with its advice, exploration, a warm start and a biased
  history.

## 0.2.0 (2026-11-16)

- **Connections**: a registry tells vendor, connection and model apart.
  Each connection has its vendor, type (CLI, API key, coding plan), sign-in,
  cost model, terms standing, what it supports and whether it starts on; a
  vendor has one connection per way to reach it (Anthropic:
  `claude-code-local` and `claude-api`).
- **CLIs over ACP**: GitHub Copilot, Qwen Code, Kimi Code and Mistral Vibe,
  through one adapter on the official `@agentclientprotocol/sdk` (pinned).
  Each runs in a private folder with only its own documented sign-in; the
  agent's tools reach it over the agent's MCP server, and its built-in
  tools' permission requests are refused.
- **Vendors by API key**: OpenAI, DeepSeek, Mistral, Moonshot, Qwen (Model
  Studio), Z.ai, MiniMax and xAI, on their documented endpoints only. The
  key is checked for free by listing models, kept in the system's secure
  store, and billed per token only when allowed; DeepSeek's balance is
  shown. Coding plans (Kimi, Z.ai, MiniMax, Qwen) are separate connections,
  off by default, since their terms restrict or do not address a
  third-party agent.
- **`/connect` in sections**: CLI / Subscription, API Key, Coding Plan,
  View and Manage, clickable or by number, and `/connect
cli|api|plans|list|status|manage|disconnect <connection>`. A key is typed
  masked and checked before it is kept; then billing or the plan's terms
  are asked. `grafeno-agent login|logout <connection>` does the same from a
  terminal.
- **`claude-api`**: Claude through the official Claude Agent SDK with an
  Anthropic API key only: built-in tools off, the agent's own tools and
  permissions, no settings loaded, sessions resumed by id, step and budget
  limits, and each turn's cost counted. Always billed per token, it runs
  only with `AGENT_ALLOW_BILLING=claude-api`, which `login claude-api` asks
  about after checking the key for free. The SDK (about 335 MB) is
  installed on demand by `grafeno-agent providers install claude-api`.
- **Provider switches**: `PROVIDER_<NAME>_ENABLED` for every provider, read
  on every call; switched off, a provider is never asked or started.
  `grafeno-agent providers` shows each one's sign-in, switch, standing and
  state, and enables, disables or installs. `claude-code-local` is another
  name for `claude-code`; its standing with Pro/Max subscriptions in
  third-party orchestrators awaits Anthropic's clarification, and it is
  said wherever it is listed.
- **Isolation**: Claude Code and Codex start without any key variable, so
  `ANTHROPIC_API_KEY`, `CODEX_API_KEY` or `OPENAI_API_KEY` can never turn a
  subscription into a billed API; a reset credit is never spent.
- **Cost routing**: at equal fit, providers billed per token come after
  subscriptions and free quotas.
- **Local models and self-hosted servers**: Ollama (its own `/api/chat`,
  streamed, with the context it runs with), LM Studio (its
  OpenAI-compatible API, also headless), Bionic and any OpenAI-compatible
  endpoint, in `/connect` → **4. Local models / Self-hosted** and
  `grafeno-agent local`. Each is checked before it is kept (no link-local
  addresses, a key only over https off this computer, names resolved),
  takes a key only when it asks, and lists its models with what each can
  do (tools, vision, context, loaded), read from the server, never assumed.
  Several per kind; kept in `local-connections.json`, keys in the secure
  store.
- **Routing to local models**: in Auto, simple tasks and sorting requests
  go first to a local model that takes tools with enough context; harder
  ones after subscriptions and free quotas, and before anything billed per
  token. A model not known to take tools takes no tool work.
  `AGENT_LOCAL_ROUTING` (`light`, `first`, `last`).
- **A leader for orchestrated runs**: `/leader` (or `AGENT_LEADER`,
  `orchestrate --leader provider/model`) chooses a model of one of Auto's
  providers to plan the run, give each task to a sub-agent (provider and
  model, followed when it can take it), decide the sub-agents' requests,
  and audit every task after its checks: approve it, or send it back with
  what to fix (up to three times), and leave suggestions that reach the
  tasks after it. The plan says who leads; the Result says what it
  approved and sent back.
- **Searchable, scrolling lists**: long lists (models, the leader, a
  provider's models in Auto) are searched by name as you type; every list,
  `/connect`'s sections included, scrolls with the arrows, Page Up/Down
  and the mouse wheel, and says how many rows are above and below. The
  wheel scrolls an open menu, not the conversation behind it.
- **Grafeno Sandbox**: the agent's commands, background processes and a
  run's checks run in sandboxes the agent makes and destroys, installed
  with it (no Docker, no daemon). Linux: a native helper in the package,
  checked against its SHA-256 (user, PID, mount and network namespaces,
  Landlock, seccomp, cgroups v2 or rlimits, as the kernel allows without
  privileges); macOS: `sandbox-exec`; Windows: AppContainer and Job
  Objects. Each result says what isolated it, never more; `AGENT_SANDBOX`
  (`auto`, `required`, `off`), `AGENT_SANDBOX_NETWORK`,
  `AGENT_SANDBOX_KEEP`; `/sandbox status|list|create|inspect|stop|destroy|cleanup`
  and `grafeno-agent sandbox`. A sandbox has its own home and caches, so
  installs never change the computer's; no credentials go in. The release
  builds and tests the helpers on x64 and arm64 before packing them.
- **Local providers show tokens, not a quota**: the side panel and
  `/usage` show only the tokens a local or self-hosted server used.
- The OpenAI-compatible adapter streams (for local servers), sends no key
  when a server needs none, takes inference settings and a timeout, and
  never follows a redirect.

## 0.1.6 (2026-11-16)

- **Documents**: `read_document` reads PDF, Word, Excel, PowerPoint and
  OpenDocument files (by page, slide or sheet), on this computer, with no
  other programs. `web_fetch` reads PDFs on the web too.
- **Images**: `read_file` shows the model PNG, JPEG, GIF and WebP images
  (up to 5 MB), over MCP to Claude Code and Codex, and to Gemini and
  OpenRouter's vision models.
- **Web search**: `web_search`, with your Brave Search or Tavily key or
  your own SearXNG (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`,
  `SEARXNG_URL`, `WEB_SEARCH`); it asks first, and its keys are hidden from
  commands. `grafeno-agent check` says which service is in use.
- **Folded actions**: finished actions in a row fold into one line (`Read 3
files, edited a file, ran 2 commands`); a click unfolds a group into each
  action and what it did (changes as `-`/`+` lines, outputs, errors), and
  ctrl+o unfolds or folds them all, in sub-agents' views too.
- **Results**: a turn that did something closes with how long it worked and
  what it did, and the agent ends with the result of the work. A run ends
  with **Result**: tasks done, what each one did or why not, and where the
  work is; its technical details are folded under **Run details**.
- Clicks land where they should in a scrolled conversation.

## 0.1.5 (2026-11-16)

- **Delete conversations**: in `/resume` (or `[Sessions]`), **d** or a
  row's `[delete]`, after a confirmation; `grafeno-agent sessions` lists
  them and `sessions delete <id>` deletes one. The open conversation is
  never deleted; what the agent stored in its memory stays.
- **No more "Stopped at the step limit"**: a chat turn carries on by itself
  past its step limit (40 requests a round, up to ten rounds), and says so
  only if it still is not done. Sub-agents get six rounds per attempt.
- **Hot downgrade**: a sub-agent that spends 8% or more of its provider's
  window and is not done moves, between rounds, to a lighter model that
  takes over from its progress (economy and balanced; never for models
  chosen by hand nor the hardest tasks).
- **Menus**: Esc closes the menu open (or goes back to the orchestrator)
  without interrupting work; a second click on a menu button closes it,
  another button moves to its menu; the open one shows pressed; buttons
  that only look stay on while the agent works.
- **A clearer conversation**: each action as a verb, its target and what
  came of it; answers under ◆ Grafeno Agent; framed code, diffs coloured.
- **Sub-agents as a tree** under the orchestrator: task as title, model
  under it, then what it is doing.
- **Projects**: `/projects` and `[Projects]` list, add and make projects
  (a folder with git); opening one starts a session in its folder.
  `grafeno-agent projects` does the same from the shell.
- **A namespace per project**: the sessions of a project share its own
  namespace in Grafeno (`<GRAFENO_NAMESPACE>--<project>`, made by its first
  session); sessions outside a project share `GRAFENO_NAMESPACE`.
  Deleting a project (`− Delete a project`, `projects remove <name>`) asks
  first, then drops its namespace, conversations and runs; never its
  folder, and nothing if the namespace cannot be dropped. The agent's key
  needs admin on `<GRAFENO_NAMESPACE>*`: the included Grafeno's is remade
  once by itself.

## 0.1.4 (2026-11-16)

- **The interface takes clicks**: a menu bar of the main commands under the
  header, rows of every list, the commands offered as you type `/`, the
  agents panel, the side panel's sections, `/connect` (a provider, its
  place in Auto, its models) and the permission buttons. Every click has a
  command or a key that does the same.
- **Minimum sufficient model routing** (`economy` and `balanced`, with
  `AGENT_ROUTER=learned`, the defaults): each attempt runs on the cheapest
  model and effort likely enough to pass the task's checks, from a stated
  prior corrected by recorded evidence, counting the cost of retries and
  escalations. The planner's recommendation is advice only; its prompt now
  gives complexity a scale. Codex's standard tier no longer starts with a
  deep model. `quality`, `rules`, `shadow` and models chosen by hand keep
  their behaviour. See `docs/routing.md`.
- **Escalation**: a failure of the environment changes nothing; failed
  checks are retried once on the same arm, then the attempt moves up; a
  task stops at a quarter of a plan's window.
- **Objective records**: each attempt keeps whether its checks passed,
  whose doing a failure was (model, environment or ambiguous, by code),
  how often a person answered, the task's risk and technology, the model's
  exact version and the arm it escalated from. `metrics.db` files made
  before get the new columns, with their rows kept.
- **`grafeno-agent router`** shows what each model was seen to do, how well
  the router knows its arms, and warns when deep models take too much of
  the work that is not hard; `--decisions <run>` prints each decision with
  its candidates. `npm run eval:routing` compares the old rules and the new
  router on fixed tasks (simulated).
- **Permission requests are no longer refused by accident**: Enter does not
  answer them (only y, n or esc do), keys pressed the moment one appears
  are not taken as its answer, and requests from several sub-agents wait
  in turn ("2 more waiting") instead of replacing one another. The notice
  says what was allowed or refused, the command included ("Not allowed:
  run in the project: python -c ...").

## 0.1.3 (2026-11-15)

- **The right panel follows the agent on screen**: on a sub-agent, its own
  task, state, model, tier and effort, tokens, context, time working,
  folder and branch, and its last report; on the main agent, as before.
- **Sub-agents and the orchestrator talk**: sub-agents report their
  progress (`report_progress`), shown as it comes and given to the main
  agent with the run's report; they ask for more work (`request_work`: a
  finished task done again, or a new task), which the orchestrator decides
  with the planner's model after code checks. Rejected, the sub-agent gets
  the reason; accepted, it becomes a task of the plan that says who asked
  and why. Four requests per run at most.
- **Runs spend the plans with care** (`AGENT_ROUTING`, `balanced` by
  default): the deep tier and high efforts only for hard tasks
  (complexity 4–5), whatever the planner asks; one effort lower from half
  of a window, a tier lighter from 70%, a hold at 95%; a provider that took
  most of a run's tasks yields to another with room. `economy` and
  `quality` too.
- **What each model spends is learned and kept**: every attempt measures
  the share of its provider's window it took; kept in the metrics across
  sessions and projects and learned as a run goes, so a model seen to take
  8% or more of a window per task is kept off simple tasks from then on.
- **Each provider's models in Auto**: **m** in `/connect` (or
  `AGENT_AUTO_MODELS`) chooses Auto or specific models per provider;
  chosen models are routed by the task among themselves, never swapped by
  usage or cost.
- **The run's work reaches your folder task by task** (`AGENT_DELIVERY`,
  `live` by default): each task's work is merged into your branch as soon
  as its checks pass, everything is checked together at the end (and
  undone if that fails), changes of yours are kept safe by git. The run
  says where its sub-agents work, and each delivery.

## 0.1.2 (2026-11-15)

- **On npm as `@grafenodb/agent-cli`**: `npm install -g
@grafenodb/agent-cli` installs the `grafeno-agent` command. A tag
  publishes it through trusted publishing (OIDC, with provenance) after the
  pipeline is green, and the GitHub release carries the same package.
  Settings, sessions and data stay where they were.
- **Builds without the optional meaning runtime**: transformers.js is
  loaded by name, so neither building nor running needs it installed (the
  0.1.1 release failed to build where it was missing; 0.1.1 was tagged but
  never released).

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
