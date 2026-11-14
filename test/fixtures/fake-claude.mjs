// A stand-in for the `claude` program, speaking its stream-json protocol, so
// the Claude Code adapter can be tested without spending any plan usage.
// Each user message is a command:
//   call:<tool>:<json>   call the tool over the MCP config given, then say its result
//   fail:<status>:<text> end the turn with an API error
//   limit                report the usage limit reached, then fail
//   logout               fail as a program that is not signed in
//   exit                 end the program
//   args                 say the command-line arguments, as JSON
//   system               say the system prompt
//   slow                 never answer
//   anything else        say "echo:<message>"
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 1,
};

const say = (text, content = [{ type: "text", text }]) =>
  out({ type: "assistant", message: { role: "assistant", content } });
const ok = (text, numTurns = 1) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: text,
    num_turns: numTurns,
    usage,
  });
const error = (text, status = null) =>
  out({
    type: "result",
    subtype: "success",
    is_error: true,
    result: text,
    api_error_status: status,
    usage,
  });

out({ type: "system", subtype: "init", tools: [] });

async function callTool(name, input) {
  const config = JSON.parse(readFileSync(option("mcp-config"), "utf8")).mcpServers.agent;
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }),
  );
  const listed = await client.listTools();
  const result = await client.callTool({ name, arguments: input });
  await client.close();
  return { listed: listed.tools.map((t) => t.name), result };
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line).message.content;
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1794680400, status: "allowed" } },
    },
  });
  if (message.startsWith("call:")) {
    const [, tool, json] = message.match(/^call:([^:]+):(.*)$/s);
    say("", [
      { type: "text", text: "Calling. " },
      { type: "tool_use", id: "t1", name: `mcp__agent__${tool}`, input: JSON.parse(json) },
    ]);
    const { listed, result } = await callTool(tool, JSON.parse(json));
    const text = `${result.isError ? "error" : "result"}:${result.content[0].text} tools:${listed.join(",")}`;
    say(text);
    ok(text, 2);
  } else if (message.startsWith("fail:")) {
    const [, status, text] = message.match(/^fail:(\d+):(.*)$/s);
    error(text, Number(status));
  } else if (message === "limit") {
    out({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1794680400, rateLimitType: "five_hour" },
    });
    error("Claude usage limit reached.");
  } else if (message === "logout") {
    error("Not logged in · Please run /login");
  } else if (message === "exit") {
    process.exit(3);
  } else if (message === "args") {
    say(JSON.stringify(args));
    ok(JSON.stringify(args));
  } else if (message === "system") {
    const text = readFileSync(option("system-prompt-file"), "utf8");
    say(text);
    ok(text);
  } else if (message === "slow") {
    // Never answer.
  } else {
    say(`echo:${message}`);
    ok(`echo:${message}`);
  }
}
