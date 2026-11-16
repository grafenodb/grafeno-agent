import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxEngine } from "../../src/sandbox/engines.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { runCommandTool } from "../../src/tools/command.js";
import { ProcessManager } from "../../src/tools/processes.js";
import { Workspace } from "../../src/tools/workspace.js";

/**
 * Grafeno Sandbox on a real Linux: the helper built from native/sandbox,
 * named by GRAFENO_SANDBOX_HELPER (CI builds it; elsewhere these are skipped).
 */
const helper = process.env.GRAFENO_SANDBOX_HELPER;
const linux = process.platform === "linux" && helper !== undefined && existsSync(helper);
const signal = new AbortController().signal;
const shell: [string, ...string[]] = ["/bin/sh", "-c"];

describe.skipIf(!linux)("Grafeno Sandbox on Linux", { timeout: 60_000 }, () => {
  let dir: string;
  let work: string;
  let secret: string;
  let manager: SandboxManager;
  let run: (command: string) => Promise<string>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-linux-sbx-"));
    work = join(dir, "work");
    mkdirSync(work);
    // Something of the person's, outside the project: in the home folder, as keys are.
    secret = mkdtempSync(join(homedir(), ".ga-secret-"));
    writeFileSync(join(secret, "id_test"), "PRIVATE KEY");
    const env = { GRAFENO_SANDBOX_HELPER: helper, PATH: process.env.PATH };
    manager = new SandboxManager({
      dir: join(dir, "sandboxes"),
      engine: new LinuxEngine(env),
      env,
    });
    const made = manager.create({ label: "test", workspace: work });
    const tool = runCommandTool(new Workspace(work), {
      shell,
      spawner: manager.spawner(() => made),
    });
    run = async (command) => (await tool.run({ command }, { signal })) as string;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  });

  it("is available, and says what it applies", async () => {
    const report = await manager.report();
    expect(report.available).toBe(true);
    const out = await run("echo hi");
    // No network namespace (user namespaces not allowed): only TCP is blocked, and it says so.
    expect(out).toMatch(/^Exit code 0 \(sandboxed \(files closed off, no (network|TCP)/);
  });

  it("writes in the project, and nowhere of the person's", async () => {
    expect(await run("echo ok > made.txt && cat made.txt")).toContain("ok");
    expect(readFileSync(join(work, "made.txt"), "utf8").trim()).toBe("ok");
    const read = await run(`cat ${join(secret, "id_test")}`);
    expect(read).not.toContain("PRIVATE KEY");
    expect(read).toMatch(/^Exit code [1-9]/);
    expect(await run(`echo x > ${join(secret, "new")}`)).toMatch(/^Exit code [1-9]/);
    expect(existsSync(join(secret, "new"))).toBe(false);
    expect(await run("echo x > /etc/grafeno-test")).toMatch(/^Exit code [1-9]/);
  });

  it("has its own home: what it installs stays in the sandbox", async () => {
    const out = await run('echo "$HOME|$npm_config_prefix|$SSH_AUTH_SOCK"');
    expect(out).toContain(join(dir, "sandboxes"));
    expect(out).not.toContain(homedir() + "|");
    expect(out).toMatch(/\|$/m);
  });

  it("closes the network to commands that do not install or fetch", async () => {
    const out = await run("exec 3<>/dev/tcp/1.1.1.1/80 && echo connected");
    expect(out).not.toContain("connected");
  });

  it("refuses ways out of the sandbox", async () => {
    expect(await run("unshare -U true && echo escaped")).not.toContain("escaped");
  });

  it("leaves nothing running once a command ends, or its sandbox is destroyed", async () => {
    await run("sleep 300 & echo started");
    await new Promise((r) => setTimeout(r, 1000));
    const ps = (await import("node:child_process")).execFileSync("ps", ["-eo", "args"], {
      encoding: "utf8",
    });
    expect(ps).not.toMatch(/^sleep 300$/m);
    const id = manager.list()[0]?.id ?? "";
    const processes = new ProcessManager(new Workspace(work), {
      shell,
      spawner: manager.spawner(
        () => manager.get(id) ?? manager.create({ label: "x", workspace: work }),
      ),
    });
    await processes.start("sleep 400", ".");
    await new Promise((r) => setTimeout(r, 500));
    expect(manager.get(id)?.running).toBe(1);
    expect(manager.destroy(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    const after = (await import("node:child_process")).execFileSync("ps", ["-eo", "args"], {
      encoding: "utf8",
    });
    expect(after).not.toMatch(/^sleep 400$/m);
    expect(existsSync(join(dir, "sandboxes", id))).toBe(false);
  });
});
