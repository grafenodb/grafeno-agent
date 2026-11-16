import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolOutcome, ToolSpec } from "./types.js";

/** Runs one call of one of the offered tools. */
export type CallHandler = (name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;

export interface McpToolServer {
  /** Where an MCP client reaches it (Streamable HTTP). */
  readonly url: string;
  /** Headers the client must send: a secret made for this server only. */
  readonly headers: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/**
 * Serves the agent's tools over MCP on 127.0.0.1, at a random port, to the
 * one client holding its secret. This is how a model run by another program
 * (Claude Code) calls the agent's own tools, which run in this process.
 */
export async function serveTools(
  tools: readonly ToolSpec[],
  handle: CallHandler,
): Promise<McpToolServer> {
  const secret = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${secret}`);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  function authorized(request: IncomingMessage): boolean {
    const given = Buffer.from(request.headers.authorization ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function mcpServer(): McpServer {
    // The low-level handlers: the tools come with JSON Schemas, not zod.
    const mcp = new McpServer(
      { name: "grafeno-agent", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const server = mcp.server;
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: "object" as const, ...tool.inputSchema },
        annotations: { readOnlyHint: !tool.writes },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      if (!byName.has(name)) {
        return { content: [{ type: "text", text: `No such tool: ${name}` }], isError: true };
      }
      try {
        const outcome = await handle(name, request.params.arguments ?? {});
        return {
          content: [
            { type: "text" as const, text: outcome.content },
            ...(outcome.images ?? []).map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mediaType,
            })),
          ],
          isError: outcome.isError ?? false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `The tool failed: ${message}` }], isError: true };
      }
    });
    return mcp;
  }

  const http: HttpServer = createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    // Stateless: a server and transport per request, as the MCP SDK advises.
    const server = mcpServer();
    const transport = new StreamableHTTPServerTransport({}); // no session id: stateless
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    headers: { Authorization: `Bearer ${secret}` },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
}
