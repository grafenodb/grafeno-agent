import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpCommand, parseServer } from "../../src/app/mcp-command.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import { connectMcp, mcpToolName } from "../../src/mcp/client.js";
import {
  expand,
  loadMcpConfig,
  looksLikeSecret,
  removeMcpServer,
  saveMcpServer,
} from "../../src/mcp/config.js";

const SERVER = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const fixture = { command: process.execPath, args: [SERVER] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-mcp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the MCP servers file", () => {
  it("keeps servers, reads them back, and says what is wrong", () => {
    const path = join(dir, "mcp.json");
    expect(loadMcpConfig(path)).toEqual({ servers: {}, problems: [] });
    saveMcpServer("notes", fixture, path);
    saveMcpServer(
      "remote",
      { url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      path,
    );
    expect(Object.keys(loadMcpConfig(path).servers)).toEqual(["notes", "remote"]);
    expect(removeMcpServer("notes", path)).toBe(true);
    expect(removeMcpServer("notes", path)).toBe(false);
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          ok: { command: "x" },
          both: { command: "x", url: "https://a" },
          "bad name": { command: "x" },
          ftp: { url: "ftp://a" },
        },
      }),
    );
    const read = loadMcpConfig(path);
    expect(Object.keys(read.servers)).toEqual(["ok"]);
    expect(read.problems.join("\n")).toMatch(/both: it needs either a command or a url/);
    expect(read.problems.join("\n")).toMatch(/bad name/);
    expect(read.problems.join("\n")).toMatch(/ftp: the url is http or https/);
    writeFileSync(path, "{ not json");
    expect(loadMcpConfig(path).problems[0]).toMatch(/not valid JSON/);
  });

  it("takes ${NAME} from the environment, and tells a secret written in full", () => {
    expect(expand("Bearer ${TOKEN}", { TOKEN: "abc" })).toEqual({
      value: "Bearer abc",
      missing: [],
    });
    expect(expand("${A}-${B}", { A: "1" })).toEqual({ value: "1-", missing: ["B"] });
    expect(looksLikeSecret("Bearer ghp_0123456789abcdefghijklmnop")).toBe(true);
    expect(looksLikeSecret("Bearer ${GITHUB_TOKEN}")).toBe(false);
    expect(looksLikeSecret("application/json")).toBe(false);
  });
});

describe("an MCP server's tools", { timeout: 60_000 }, () => {
  it("reach the agent, asked before they change anything, unless read-only", async () => {
    const connection = await connectMcp("notes", fixture, { env: {} });
    try {
      expect(connection.error).toBeUndefined();
      const names = connection.tools.map((t) => t.name);
      expect(names).toEqual([
        "mcp_notes_read_note",
        "mcp_notes_write_note",
        "mcp_notes_delete_all",
        "mcp_notes_fail",
        "mcp_notes_env",
      ]);
      const byName = (n: string) => connection.tools.find((t) => t.name === n);
      expect(byName("mcp_notes_read_note")?.permission?.({}).permission).toBe("free");
      expect(byName("mcp_notes_write_note")?.permission?.({}).permission).toBe("ask");
      expect(byName("mcp_notes_delete_all")?.permission?.({}).reason).toMatch(
        /delete or overwrite/,
      );

      // Through the agent's own registry: what is asked, and what the server answers.
      const asked: string[] = [];
      const registry = new ToolRegistry([...connection.tools], (call) => {
        asked.push(call.name);
        return false;
      });
      const signal = new AbortController().signal;
      expect(
        await registry.call({ id: "1", name: "mcp_notes_read_note", input: { id: "7" } }, signal),
      ).toEqual({
        content: "note 7",
      });
      const refused = await registry.call(
        { id: "2", name: "mcp_notes_write_note", input: { text: "hi" } },
        signal,
      );
      expect(refused.isError).toBe(true);
      expect(asked).toEqual(["mcp_notes_write_note"]);
      const allowed = new ToolRegistry([...connection.tools], () => true);
      expect(
        (
          await allowed.call(
            { id: "3", name: "mcp_notes_write_note", input: { text: "hi" } },
            signal,
          )
        ).content,
      ).toBe("saved hi");
      const failed = await allowed.call({ id: "4", name: "mcp_notes_fail", input: {} }, signal);
      expect(failed).toMatchObject({ isError: true });
      expect(failed.content).toContain("broken");
    } finally {
      await connection.close();
    }
  });

  it("gives a program only a minimal environment and what its configuration sets, never the agent's keys", async () => {
    const before = { key: process.env.GRAFENO_AGENT_KEY, gemini: process.env.GEMINI_API_KEY };
    process.env.GRAFENO_AGENT_KEY = "gk_should_not_leak";
    process.env.GEMINI_API_KEY = "AIza_should_not_leak";
    const connection = await connectMcp(
      "notes",
      { ...fixture, env: { FIXTURE_TOKEN: "${FIXTURE_SECRET}" } },
      { env: { FIXTURE_SECRET: "from-env" } },
    );
    try {
      const env = connection.tools.find((t) => t.name === "mcp_notes_env");
      const seen = JSON.parse(
        (await env?.run({}, { signal: new AbortController().signal })) as string,
      ) as Record<string, unknown>;
      expect(seen).toEqual({ agentKey: null, gemini: null, token: "from-env" });
    } finally {
      await connection.close();
      if (before.key === undefined) Reflect.deleteProperty(process.env, "GRAFENO_AGENT_KEY");
      else process.env.GRAFENO_AGENT_KEY = before.key;
      if (before.gemini === undefined) Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
      else process.env.GEMINI_API_KEY = before.gemini;
    }
  });

  it("says when a server cannot be reached, and when its variables are not set", async () => {
    const missing = await connectMcp(
      "ghost",
      { command: join(dir, "no-such-program") },
      { env: {}, timeoutMs: 5000 },
    );
    expect(missing.error).toBeDefined();
    expect(missing.tools).toEqual([]);
    const silent = await connectMcp(
      "silent",
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        env: { X: "${NOT_SET}" },
      },
      { env: {}, timeoutMs: 800 },
    );
    expect(silent.error).toMatch(/did not answer in time/);
    expect(silent.missing).toEqual(["NOT_SET"]);
    await silent.close();
    expect(mcpToolName("my.server", "do/it")).toBe("mcp_my_server_do_it");
  });
});

describe("grafeno-agent mcp", { timeout: 60_000 }, () => {
  it("checks a server before keeping it, and lists each with its tools", async () => {
    const path = join(dir, "mcp.json");
    const said: string[] = [];
    const say = (line: string) => said.push(line);
    expect(await mcpCommand(["add", "notes", "--", process.execPath, SERVER], { say, path })).toBe(
      0,
    );
    expect(said.join("\n")).toContain("notes answered with 5 tools");
    expect(loadMcpConfig(path).servers.notes).toEqual({
      command: process.execPath,
      args: [SERVER],
    });

    // One that does not answer is not kept.
    said.length = 0;
    expect(await mcpCommand(["add", "ghost", "--", join(dir, "nothing-here")], { say, path })).toBe(
      1,
    );
    expect(said.join("\n")).toMatch(/Not kept/);
    expect(Object.keys(loadMcpConfig(path).servers)).toEqual(["notes"]);

    said.length = 0;
    expect(await mcpCommand(["list"], { say, path })).toBe(0);
    expect(said.join("\n")).toMatch(/notes\s+✓ 5 tools/);
    expect(await mcpCommand(["remove", "notes"], { say, path })).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a secret written in full, and takes ${NAME} instead", async () => {
    const path = join(dir, "mcp.json");
    const said: string[] = [];
    const connect = () =>
      Promise.resolve({ name: "x", tools: [], missing: [], close: () => Promise.resolve() });
    expect(
      await mcpCommand(
        [
          "add",
          "gh",
          "--url",
          "https://mcp.example.test/mcp",
          "--header",
          "Authorization=Bearer ghp_0123456789abcdefghijklmnop",
        ],
        {
          say: (l) => said.push(l),
          path,
          connect,
        },
      ),
    ).toBe(2);
    expect(said.join("\n")).toMatch(/looks like a secret/);
    expect(existsSync(path)).toBe(false);
    expect(
      await mcpCommand(
        [
          "add",
          "gh",
          "--url",
          "https://mcp.example.test/mcp",
          "--header",
          "Authorization=Bearer ${GITHUB_TOKEN}",
        ],
        {
          say: (l) => said.push(l),
          path,
          connect,
        },
      ),
    ).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("${GITHUB_TOKEN}");
    expect(parseServer(["--url", "ftp://x"])).toMatch(/http or https/);
    expect(parseServer(["--env", "NOEQUALS", "--", "prog"])).toMatch(/NAME=value/);
    expect(parseServer(["--", "npx", "-y", "server", "--flag"])).toEqual({
      command: "npx",
      args: ["-y", "server", "--flag"],
    });
  });
});

describe("Grafeno's own MCP server", () => {
  it("is listed first, always on, and cannot be taken, removed or turned off", async () => {
    const path = join(dir, "mcp.json");
    const said: string[] = [];
    const say = (line: string) => said.push(line);
    const env = { GRAFENO_URL: "http://127.0.0.1:7810", GRAFENO_NAMESPACE: "agent-ns" };
    expect(await mcpCommand(["list"], { say, path, env })).toBe(0);
    expect(said[0]).toMatch(
      /grafeno\s+built in · always on · the agent's memory \(http:\/\/127\.0\.0\.1:7810, namespace agent-ns\)/,
    );
    expect(said.join("\n")).toContain("No external MCP servers yet");

    said.length = 0;
    expect(
      await mcpCommand(["add", "grafeno", "--url", "http://example.com/mcp"], { say, path }),
    ).toBe(2);
    expect(said.join("\n")).toContain("the agent's own MCP server");
    expect(await mcpCommand(["remove", "grafeno"], { say, path })).toBe(2);
    expect(said.join("\n")).toContain("cannot be removed or turned off");

    // A file that names a server grafeno: refused, said.
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { grafeno: { url: "http://example.com/mcp" } } }),
    );
    const config = loadMcpConfig(path);
    expect(config.servers).toEqual({});
    expect(config.problems.join("\n")).toContain("built in and always on");
  });
});
