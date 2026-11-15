# First real runs with two providers (phase B)

Date: 2026-11-15. Claude through Claude Code (the user's Pro plan) and
Codex through codex-cli 0.169.0 (the user's ChatGPT Plus plan). Grafeno
0.3.0 on 127.0.0.1:7810, Node 26.13.1, Windows 11. Every run used
`--light --yes`, in the `controlled` mode.

The project was `mathkit`, a fresh git repository with `package.json`
(`"type": "module"`, `"test": "node --test"`) and a one-line README. The
request asked for three tasks:

1. `src/clamp.js`, exporting `clamp(value, min, max)`, which throws a
   `RangeError` when `min > max`;
2. `test/clamp.test.js`, accepted when `node --test` passes;
3. a Usage section in the README.

## Run 1 — `run-2026-11-15-118b51e5`: Claude's task merged, Codex's wrote nothing

The run used `--providers claude-code,codex --provider-for tests=codex,docs=codex`.

| Task           | Provider and model       | Attempts | Result                           |
| -------------- | ------------------------ | -------- | -------------------------------- |
| `clamp-module` | claude-code / haiku, low | 1        | merged                           |
| `clamp-tests`  | codex / gpt-6-luna, low  | 3        | failed: `test/clamp.test.js` missing |
| `readme-usage` | codex / gpt-6-luna, low  | 3        | failed: no Usage section           |

The routing was as set. The Codex workers changed no file in six attempts,
and a probe found why:

1. **Codex's own patch tool.** Told nothing, Codex tried its own patch
   tool. The read-only sandbox rejected it, and Codex answered that the
   workspace is read-only, without trying the agent's tools.
2. **Codex's own approval.** Told about the agent's tools, it called
   them, but Codex itself asked for approval of every tool that writes.
   With its approvals off, it refused them.

Fixes in `src/model/codex.ts`:

1. **Before the agent's instructions, every turn, a short preface:** it
   has no shell and cannot edit files itself, and everything in the
   project goes through the `agent` MCP server's tools, named one by one.
2. **`mcp_servers.agent.default_tools_approval_mode = "approve"`:** each
   call of the agent's tools is decided by the agent's own permissions
   (the tool registry and the run's policy), not by Codex.
3. **The cancel race:** a turn ends as cancelled before its process is
   stopped.

After the fixes, a probe wrote a file through `write_file`, and the model
contract passed 4/4 on real Codex.

## Run 2 — `run-2026-11-15-7c212747`: completed, and routed by quota

The run used `--providers codex,claude-code --provider-for backend=claude-code`.
Codex went first to spare Claude's plan, which was 86 % used: the planner
runs on the first provider.

| Task           | Provider and model        | Attempts | Result |
| -------------- | ------------------------- | -------- | ------ |
| `clamp-module` | codex / gpt-6.1-sol, low  | 1        | merged |
| `clamp-tests`  | codex / gpt-6-luna, low   | 1        | merged |
| `readme-usage` | codex / gpt-6-luna, low   | 1        | merged |

Totals: 3 attempts; 76.0k input, 1.6k output and 195.7k cache tokens; 66 s
of work, 82 s of wall clock with planning.

`clamp-module` was set for Claude, but the router recorded "claude-code is
near its limit, codex has room". Above 80 % of a window, a task goes to
another provider with room before it would go a tier lighter, so it went
to Codex on the standard tier (the planner recommended standard). This is
phase B's rule working on real usage: the kind's preferred provider gives
way to the plan's limit.

There was 1 question for a person: the module worker wanted to run an
ad-hoc `node -e` assertion that was not one of its checks, and was
refused.

Checked afterwards:

- **The integration branch:** `grafeno/7c212747/integration` holds three
  commits, each authored by its worker, changing three files (36 lines in
  all).
- **The tests:** `node --test` on that branch gives 4 tests, 4 passed.
- **The user's branch:** `main` is untouched and clean.

## Not shown yet

A run where Claude and Codex workers both finish their tasks: in run 1 the
Codex workers failed (before the fixes), and in run 2 Claude was near its
limit. To repeat when Claude's window has room. It is a small run, about
one Claude task and a planner call.
