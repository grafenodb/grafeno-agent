import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MacEngine } from "../../src/sandbox/engines.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { runCommandTool } from "../../src/tools/command.js";
import { Workspace } from "../../src/tools/workspace.js";

/** Grafeno Sandbox on a real Mac (sandbox-exec); skipped elsewhere. */
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const signal = new AbortController().signal;

describe.skipIf(!mac)("Grafeno Sandbox on macOS", { timeout: 60_000 }, () => {
  let dir: string;
  let work: string;
  let secret: string;
  let run: (command: string) => Promise<string>;
  beforeEach(() => {
    // The real path: /var is /private/var on macOS.
    dir = execFileSync("realpath", [mkdtempSync(join(tmpdir(), "ga-mac-sbx-"))], {
      encoding: "utf8",
    }).trim();
    work = join(dir, "work");
    mkdirSync(work);
    secret = mkdtempSync(join(homedir(), ".ga-secret-"));
    writeFileSync(join(secret, "id_test"), "PRIVATE KEY");
    const env = { PATH: process.env.PATH };
    const manager = new SandboxManager({
      dir: join(dir, "sandboxes"),
      engine: new MacEngine(env),
      env,
    });
    const made = manager.create({ label: "test", workspace: work });
    const tool = runCommandTool(new Workspace(work), {
      shell: ["/bin/sh", "-c"],
      spawner: manager.spawner(() => made),
    });
    run = async (command) => (await tool.run({ command }, { signal })) as string;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  });

  it("writes in the project, and nowhere of the person's", async () => {
    expect(await run("echo ok > made.txt && cat made.txt")).toMatch(/^Exit code 0 \(sandboxed/);
    expect(await run(`cat ${join(secret, "id_test")}`)).not.toContain("PRIVATE KEY");
    expect(await run(`echo x > ${join(secret, "new")}`)).toMatch(/^Exit code [1-9]/);
    expect(existsSync(join(secret, "new"))).toBe(false);
  });

  it("closes the network to commands that do not install or fetch", async () => {
    const out = await run("/usr/bin/nc -z -G 3 1.1.1.1 80 && echo connected");
    expect(out).not.toContain("connected");
  });
});
