// A stand-in for a CLI's ACP server (NDJSON JSON-RPC over stdio), for the
// tests of the agent's ACP adapter. FAKE_ACP_MODE picks how it behaves:
// "ok" (default), "auth" (not signed in), "nohttp" (no HTTP MCP servers).
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mode = process.env.FAKE_ACP_MODE ?? "ok";
let mcp;
let nextId = 1000;
const pending = new Map();
let cancelled;

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id) && msg.method === undefined) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  void handle(msg);
});

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          agentCapabilities: {
            loadSession: false,
            mcpCapabilities: { http: mode !== "nohttp", sse: false },
          },
          authMethods: [],
        },
      });
      return;
    case "session/new": {
      if (mode === "auth") {
        send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      const server = msg.params.mcpServers.find((s) => s.type === "http");
      mcp = server;
      send({ id: msg.id, result: { sessionId: "s-1" } });
      return;
    }
    case "session/cancel":
      cancelled?.();
      return;
    case "session/prompt": {
      const sessionId = msg.params.sessionId;
      const text = msg.params.prompt.map((b) => b.text ?? "").join("");
      if (text === "wait") {
        // A long turn, until the client cancels it.
        await new Promise((resolve) => {
          cancelled = resolve;
        });
        send({ id: msg.id, result: { stopReason: "cancelled" } });
        return;
      }
      if (text === "env") {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              agentKey: process.env.GRAFENO_AGENT_KEY ?? null,
              anthropic: process.env.ANTHROPIC_API_KEY ?? null,
              gh: process.env.GH_TOKEN ?? null,
              cwd: process.cwd(),
              server: mcp?.name ?? null,
              headers: (mcp?.headers ?? []).map((h) => h.name),
            }),
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
      // A built-in tool asks first: the client must refuse it.
      const builtin = await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "t1", title: "Run rm -rf /tmp/x", kind: "execute" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      // The agent's own tool asks first: the client lets it through to the agent.
      const ours = await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "t2", title: "grafeno - echo (MCP)", kind: "other" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Calling. " },
      });
      const client = new Client({ name: "fake-acp", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp.url), {
          requestInit: { headers: Object.fromEntries(mcp.headers.map((h) => [h.name, h.value])) },
        }),
      );
      const answer = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      await client.close();
      update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `${answer.content[0].text}; builtin=${builtin.outcome.optionId ?? builtin.outcome.outcome}; ours=${ours.outcome.optionId ?? ours.outcome.outcome}`,
        },
      });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      if (msg.id !== undefined)
        send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
