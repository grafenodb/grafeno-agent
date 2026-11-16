import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { permissionOf, type Tool } from "../../src/agent/tools.js";
import { defaultShell } from "../../src/tools/command.js";
import { projectTools } from "../../src/tools/index.js";
import { manageTools } from "../../src/tools/manage.js";
import { ProcessManager, processTools } from "../../src/tools/processes.js";
import { environmentInfoTool } from "../../src/tools/system.js";
import { isLoopbackUrl, localHttpTool } from "../../src/tools/web.js";
import { Workspace } from "../../src/tools/workspace.js";

let root: string;
let tools: Record<string, Tool>;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ga-env-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await writeFile(join(root, ".env"), "TOKEN=abc123456789");
  tools = Object.fromEntries(manageTools(new Workspace(root)).map((t) => [t.name, t]));
});

afterEach(async () => {
  // A stopped process may hold the folder a moment longer on Windows.
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const tool = (name: string) => tools[name] as Tool;
const permission = (name: string, input: Record<string, unknown>) =>
  permissionOf(tool(name), input).permission;

describe("the project tools", () => {
  it("offer the environment, file management, background processes and local servers", () => {
    const names = projectTools(new Workspace(root)).map((t) => t.name);
    for (const name of [
      "environment_info",
      "file_info",
      "multi_edit",
      "move_file",
      "delete_file",
      "start_process",
      "process_output",
      "stop_process",
      "list_processes",
      "local_http",
    ]) {
      expect(names).toContain(name);
    }
    expect(
      projectTools(new Workspace(root), { background: false }).map((t) => t.name),
    ).not.toContain("start_process");
  });
});

describe("file management", () => {
  it("file_info tells files from folders, freely, but never about secrets", async () => {
    expect(permission("file_info", { path: "src" })).toBe("free");
    expect(await tool("file_info").run({ path: "src" }, { signal })).toContain(
      "a folder with 1 entries",
    );
    expect(await tool("file_info").run({ path: "src/a.ts" }, { signal })).toMatch(
      /a file of \d+ bytes/,
    );
    expect(await tool("file_info").run({ path: "nope.txt" }, { signal })).toContain(
      "does not exist",
    );
    expect(permission("file_info", { path: ".env" })).toBe("never");
  });

  it("multi_edit applies every edit or none, after asking", async () => {
    expect(permission("multi_edit", { path: "src/a.ts", edits: [] })).toBe("ask");
    await expect(
      tool("multi_edit").run(
        {
          path: "src/a.ts",
          edits: [
            { old_text: "const a = 1;", new_text: "const a = 10;" },
            { old_text: "missing", new_text: "x" },
          ],
        },
        { signal },
      ),
    ).rejects.toThrow(/edit 2: old_text was not found; nothing was changed/);
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toContain("const a = 1;");
    const done = await tool("multi_edit").run(
      {
        path: "src/a.ts",
        edits: [
          { old_text: "const a = 1;", new_text: "const a = 10;" },
          { old_text: "const", new_text: "let", replace_all: true },
        ],
      },
      { signal },
    );
    expect(done).toContain("2 edits, 4 replacements");
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(
      "let a = 10;\nlet b = 2;\nlet c = 3;\n",
    );
  });

  it("move_file asks, never replaces, and never leaves the project or touches .git", async () => {
    expect(permission("move_file", { from: "src/a.ts", to: "lib/a.ts" })).toBe("ask");
    expect(permission("move_file", { from: "src/a.ts", to: "../a.ts" })).toBe("never");
    expect(permission("move_file", { from: ".env", to: "env.txt" })).toBe("never");
    expect(permission("move_file", { from: "src/a.ts", to: ".git/a.ts" })).toBe("never");
    expect(await tool("move_file").run({ from: "src/a.ts", to: "lib/a.ts" }, { signal })).toBe(
      "Moved src/a.ts to lib/a.ts.",
    );
    await writeFile(join(root, "src", "b.ts"), "b");
    await expect(
      tool("move_file").run({ from: "src/b.ts", to: "lib/a.ts" }, { signal }),
    ).rejects.toThrow(/already exists/);
  });

  it("delete_file asks, deletes files and empty folders only, never the project itself", async () => {
    expect(permission("delete_file", { path: "src/a.ts" })).toBe("ask");
    expect(permission("delete_file", { path: "." })).toBe("never");
    expect(permission("delete_file", { path: ".env" })).toBe("never");
    await expect(tool("delete_file").run({ path: "src" }, { signal })).rejects.toThrow(
      /files in it/,
    );
    await tool("delete_file").run({ path: "src/a.ts" }, { signal });
    await expect(stat(join(root, "src", "a.ts"))).rejects.toThrow();
    expect(await tool("delete_file").run({ path: "src" }, { signal })).toContain("empty folder");
  });
});

describe("environment_info", () => {
  it("says the system, the shell, the branch and which programs are installed", async () => {
    const info = environmentInfoTool(new Workspace(root), {
      shell: ["bash", "-c"],
      version: (name) =>
        Promise.resolve(
          name === "node"
            ? "v26.13.0"
            : name === "git"
              ? undefined
              : name === "cargo"
                ? "cargo 1.90.0"
                : undefined,
        ),
    });
    const text = await info.run({}, { signal });
    expect(text).toContain("Shell for commands: bash -c");
    expect(text).toContain("Git branch: (not a git repository)");
    expect(text).toContain("node: v26.13.0");
    expect(text).toContain("cargo: cargo 1.90.0");
    expect(text).toMatch(/Not found: .*docker/);
    expect(permissionOf(info, {}).permission).toBe("free");
  });
});

describe("background processes", { timeout: 30_000 }, () => {
  it("start after asking, are read while they run, and are stopped", async () => {
    const workspace = new Workspace(root);
    const manager = new ProcessManager(workspace, { shell: defaultShell() });
    const [start, output, stop, list] = processTools(manager, workspace) as [
      Tool,
      Tool,
      Tool,
      Tool,
    ];
    const command = `node -e "console.log('ready'); setInterval(() => console.log('tick'), 100)"`;
    expect(permissionOf(start, { command }).permission).toBe("ask");
    expect(permissionOf(start, { command: "sudo rm x" }).permission).toBe("never");
    expect(permissionOf(start, { command, cwd: "../x" }).permission).toBe("never");
    const started = await start.run({ command, wait_ms: 1500 }, { signal });
    expect(started).toMatch(/Process p1 \(running\)/);
    expect(started).toContain("ready");
    const first = (await output.run({ id: "p1" }, { signal })) as string;
    const offset = Number(/offset now (\d+)/.exec(first)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = await output.run({ id: "p1", since: offset }, { signal });
    expect(later).toContain("tick");
    expect(later).not.toContain("ready");
    expect(await list.run({}, { signal })).toContain("p1  running");
    expect(await stop.run({ id: "p1" }, { signal })).toContain("stopped by the agent");
    expect(() => output.run({ id: "p9" }, { signal })).toThrow(/no process p9/);
    manager.stopAll();
  });
});

describe("local_http", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ method: request.method, url: request.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("reads a local server freely, asks before changing it, and never reaches other hosts", async () => {
    const local = localHttpTool();
    expect(permissionOf(local, { url: `${base}/health` }).permission).toBe("free");
    expect(permissionOf(local, { url: `${base}/items`, method: "POST" }).permission).toBe("ask");
    expect(permissionOf(local, { url: "https://example.com/" }).permission).toBe("never");
    expect(permissionOf(local, { url: "http://192.168.1.1/" }).permission).toBe("never");
    const answer = await local.run({ url: `${base}/health` }, { signal });
    expect(answer).toMatch(/GET .*\/health → 200/);
    expect(answer).toContain('"url":"/health"');
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000/")).toBe(true);
    expect(isLoopbackUrl("http://user:pw@localhost/")).toBe(false);
  });
});
