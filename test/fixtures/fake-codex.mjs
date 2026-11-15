// A stand-in for the `codex` program's `exec --json` mode, so the Codex
// adapter can be tested without spending any plan usage. The message on
// stdin is a command:
//   call:<tool>:<json>   call the tool over the MCP server given in the config, then say its result
//   remember:<word>      remember a word in this thread (kept in a file, as Codex keeps sessions)
//   recall               say the remembered word (only after `exec resume <thread>`)
//   config               say the -c settings, as JSON
//   argv                 say the arguments, as JSON
//   limit                fail the turn as at the plan's usage limit
//   logout               fail as a program that is not signed in
//   lost                 fail as when the session is gone
//   slow                 never answer
//   anything else        say "echo:<message>"
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setInterval } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const config = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-c") {
    const [key, ...rest] = args[i + 1].split("=");
    const raw = rest.join("=");
    try {
      config[key] = JSON.parse(raw);
    } catch {
      config[key] = raw;
    }
  }
}
const resuming = args[1] === "resume";
const thread = resuming ? args[args.length - 2] : randomUUID();
const memoryFile = join(tmpdir(), `fake-codex-${thread}.json`);
const memory = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, "utf8")) : {};
if (resuming && !existsSync(memoryFile) && thread !== "missing") {
  writeFileSync(memoryFile, "{}");
}

let message = "";
for await (const chunk of process.stdin) message += chunk;
message = message.trim();

const usage = {
  input_tokens: 120,
  cached_input_tokens: 100,
  cache_write_input_tokens: 3,
  output_tokens: 7,
};
const say = (text, id = "item_9") =>
  out({ type: "item.completed", item: { id, type: "agent_message", text } });
const done = () => out({ type: "turn.completed", usage });
const fail = (text) => {
  out({ type: "turn.failed", error: { message: text } });
  process.exit(1);
};

if (thread === "missing" || message === "lost") fail("No session found with id missing");
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });

if (message.startsWith("call:")) {
  const [, tool, json] = message.match(/^call:([^:]+):(.*)$/s);
  const url = config["mcp_servers.agent.url"];
  const token = process.env[config["mcp_servers.agent.bearer_token_env_var"]];
  const client = new Client({ name: "fake-codex", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  out({
    type: "item.started",
    item: {
      id: "item_0",
      type: "mcp_tool_call",
      server: "agent",
      tool,
      arguments: JSON.parse(json),
      status: "in_progress",
    },
  });
  const result = await client.callTool({ name: tool, arguments: JSON.parse(json) });
  await client.close();
  out({
    type: "item.completed",
    item: { id: "item_0", type: "mcp_tool_call", server: "agent", tool, status: "completed" },
  });
  say(`${result.isError ? "error" : "result"}:${result.content[0].text}`);
  done();
} else if (message.startsWith("remember:")) {
  memory.word = message.slice("remember:".length);
  writeFileSync(memoryFile, JSON.stringify(memory));
  say("ok");
  done();
} else if (message === "recall") {
  say(resuming ? `word:${memory.word ?? "?"}` : "word:none (not resumed)");
  done();
} else if (message === "config") {
  say(JSON.stringify(config));
  done();
} else if (message === "argv") {
  say(JSON.stringify(args));
  done();
} else if (message === "limit") {
  fail("You've hit your usage limit. Upgrade to Pro or try again later.");
} else if (message === "logout") {
  fail("Not logged in. Run codex login.");
} else if (message === "slow") {
  // A pending promise alone lets Node exit (code 13); a timer keeps it waiting.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else {
  say(`echo:${message}`);
  done();
}
