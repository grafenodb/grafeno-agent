// A small MCP server over stdio, for the tests of the agent's MCP client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mcp = new McpServer({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
const server = mcp.server;

const tools = [
  {
    name: "read_note",
    description: "Reads a note",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Writes a note",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "delete_all",
    description: "Deletes every note",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  {
    name: "env",
    description: "Says which variables it sees",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "read_note":
      return { content: [{ type: "text", text: `note ${String(args.id)}` }] };
    case "write_note":
      return { content: [{ type: "text", text: `saved ${String(args.text)}` }] };
    case "delete_all":
      return { content: [{ type: "text", text: "deleted" }] };
    case "env":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agentKey: process.env.GRAFENO_AGENT_KEY ?? null,
              gemini: process.env.GEMINI_API_KEY ?? null,
              token: process.env.FIXTURE_TOKEN ?? null,
            }),
          },
        ],
      };
    default:
      return { content: [{ type: "text", text: "broken" }], isError: true };
  }
});

await mcp.connect(new StdioServerTransport());
