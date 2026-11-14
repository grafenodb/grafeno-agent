# Changelog

## Unreleased

- **Include Grafeno**: on first run (or `init --include-grafeno`) the agent
  can download the official Grafeno build, checked against its checksum,
  and run it in the background on 127.0.0.1:7811, making its own key; or
  connect to a Grafeno server the user has (`GRAFENO_MODE`).
- **Providers**: a provider interface, with Claude (Claude Code) first.
  `/connect` shows whether it is installed and signed in, and the plan;
  `/palace` changes the Grafeno connection; `/models` lists models by
  their exact names and `/effort` sets the effort (`CLAUDE_EFFORT`), both
  remembered. `/usage` and the panel show the provider's real usage
  (Claude Code's own `/usage`, which spends nothing).
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

## 0.1.0 (unreleased)

The first version: a programming assistant with long-term memory in
Grafeno, used from the command line.

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
