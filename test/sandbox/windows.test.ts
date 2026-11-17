import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxCommand } from "../../src/app/sandbox-command.js";
import { WindowsEngine } from "../../src/sandbox/engines.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { runCommandTool } from "../../src/tools/command.js";
import { Workspace } from "../../src/tools/workspace.js";

/** Grafeno Sandbox on real Windows; CI and build:sandbox name the native helper. */
const helper = process.env.GRAFENO_SANDBOX_HELPER;
const windows = process.platform === "win32" && helper !== undefined && existsSync(helper);
const signal = new AbortController().signal;

describe.skipIf(!windows)("Grafeno Sandbox on Windows", { timeout: 90_000 }, () => {
  let dir: string;
  let work: string;
  let secret: string;
  let manager: SandboxManager;
  let sandboxId: string;
  let run: (command: string) => Promise<string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-windows-sbx-"));
    work = join(dir, "work");
    mkdirSync(work);
    secret = mkdtempSync(join(homedir(), ".ga-secret-"));
    writeFileSync(join(secret, "id_test"), "PRIVATE KEY");
    const env = {
      AGENT_SANDBOX: "required",
      AGENT_SANDBOX_NETWORK: "never",
      GRAFENO_SANDBOX_HELPER: helper,
      PATH: process.env.PATH,
    };
    manager = new SandboxManager({
      dir: join(dir, "sandboxes"),
      engine: new WindowsEngine(env),
      env,
    });
    const made = manager.create({ label: "test", workspace: work });
    sandboxId = made.id;
    const tool = runCommandTool(new Workspace(work), {
      shell: ["cmd.exe", "/d", "/s", "/c"],
      spawner: manager.spawner(() => made),
    });
    run = async (command) => (await tool.run({ command }, { signal })) as string;
  });

  afterEach(() => {
    manager.destroy(sandboxId);
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }, 90_000);

  it("is available, runs a real command and says what isolated it", async () => {
    expect((await manager.report()).available).toBe(true);
    const status = await sandboxCommand(["status"], manager, {
      env: { AGENT_SANDBOX: "required" },
    });
    expect(status.lines.join("\n")).toContain("Mode: required");
    expect(status.lines.join("\n")).toContain("Engine: windows");
    const out = await run("echo hello");
    expect(out).toMatch(/^Exit code 0 \(sandboxed \(files closed off, no network, limits\)\)/);
    expect(out).toContain("hello");
  });

  it("writes in the project, and cannot read or write elsewhere in the person's home", async () => {
    expect(await run("echo ok>made.txt && type made.txt")).toMatch(/^Exit code 0 \(sandboxed/);
    expect(readFileSync(join(work, "made.txt"), "utf8").trim()).toBe("ok");
    expect(await run(`type "${join(secret, "id_test")}"`)).not.toContain("PRIVATE KEY");
    expect(await run(`echo x>"${join(secret, "new")}"`)).toMatch(/^Exit code [1-9]/);
    expect(existsSync(join(secret, "new"))).toBe(false);
  });

  it("closes the network when the policy says never", async () => {
    const out = await run("curl.exe --max-time 3 https://example.com");
    expect(out).toMatch(/^Exit code [1-9] \(sandboxed \(files closed off, no network/);
  });
});
