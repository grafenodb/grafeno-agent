import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxCommand } from "../../src/app/sandbox-command.js";
import {
  MacEngine,
  NoEngine,
  describeIsolation,
  detectEngine,
  linuxHelper,
  type Isolation,
  type IsolationEngine,
} from "../../src/sandbox/engines.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { networkFor, profileFor, sandboxEnv, sandboxMode } from "../../src/sandbox/policy.js";
import { runCommandTool } from "../../src/tools/command.js";
import { Workspace } from "../../src/tools/workspace.js";

const signal = new AbortController().signal;
const shell: [string, ...string[]] =
  process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["/bin/sh", "-c"];

describe("the sandbox's policies", () => {
  it("gives the network only to commands that install or fetch, unless told otherwise", () => {
    expect(networkFor("npm install express", "auto")).toBe("open");
    expect(networkFor("pip install -r requirements.txt", "auto")).toBe("open");
    expect(networkFor("git clone https://example.com/x.git", "auto")).toBe("open");
    expect(networkFor("npm test", "auto")).toBe("none");
    expect(networkFor("npm test", "always")).toBe("open");
    expect(networkFor("npm install", "never")).toBe("none");
    expect(profileFor("npm ci", "open")).toBe("install");
    expect(profileFor("npm test", "none")).toBe("standard");
    expect(sandboxMode({})).toBe("auto");
    expect(sandboxMode({ AGENT_SANDBOX: "required" })).toBe("required");
    expect(sandboxMode({ AGENT_SANDBOX: "off" })).toBe("off");
  });

  it("keeps the person's sessions and credentials out, and its installs in the sandbox", () => {
    const env = sandboxEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        SSH_AUTH_SOCK: "/run/user/1000/ssh",
        GH_TOKEN: "ghp_x",
        AWS_SECRET_ACCESS_KEY: "s",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      { home: "/sbx/home", tmp: "/sbx/tmp" },
      (...p) => p.join("/"),
    );
    expect(env.HOME).toBe("/sbx/home");
    expect(env.TMPDIR).toBe("/sbx/tmp");
    expect(env.npm_config_prefix).toBe("/sbx/home/.npm-global");
    expect(env.npm_config_cache).toBe("/sbx/home/.npm");
    expect(env.PIP_CACHE_DIR).toBe("/sbx/home/.cache/pip");
    expect(env.PATH).toBe("/usr/bin");
    for (const gone of [
      "SSH_AUTH_SOCK",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DBUS_SESSION_BUS_ADDRESS",
    ]) {
      expect(env[gone], gone).toBeUndefined();
    }
  });

  it("says what isolated a command, never more than was applied", () => {
    const base: Isolation = {
      engine: "linux",
      files: true,
      network: "none",
      processes: true,
      syscalls: true,
      limits: true,
      mechanisms: [],
    };
    expect(describeIsolation(base)).toBe(
      "sandboxed (files closed off, no network, own processes, limits)",
    );
    expect(describeIsolation({ ...base, network: "tcp-blocked", processes: false })).toBe(
      "sandboxed (files closed off, no TCP, limits)",
    );
    expect(describeIsolation(new NoEngine("x").isolation())).toBe("not sandboxed");
    expect(detectEngine({}, "win32").name).toBe("windows");
    expect(detectEngine({}, "linux").name).toBe("linux");
    expect(detectEngine({}, "darwin").name).toBe("macos");
  });
});

/** Why a helper is not used, or "" when it is. */
function problemOf(found: ReturnType<typeof linuxHelper>): string {
  return "problem" in found ? found.problem : "";
}

describe("the Linux helper's integrity", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ga-sbx-helper-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is used only when it matches the package's manifest", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const dir = join(root, "vendor", "sandbox", `linux-${arch}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "grafeno-sandbox");
    writeFileSync(file, "#!/bin/sh\necho helper\n");
    chmodSync(file, 0o755);
    expect(problemOf(linuxHelper({}, root))).toMatch(/manifest/);
    const hash = createHash("sha256").update("#!/bin/sh\necho helper\n").digest("hex");
    const other = mkdtempSync(join(tmpdir(), "ga-sbx-helper2-"));
    try {
      const dir2 = join(other, "vendor", "sandbox", `linux-${arch}`);
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir2, "grafeno-sandbox"), "#!/bin/sh\necho helper\n");
      chmodSync(join(dir2, "grafeno-sandbox"), 0o755);
      writeFileSync(
        join(other, "vendor", "sandbox", "manifest.json"),
        JSON.stringify({ files: { [`linux-${arch}/grafeno-sandbox`]: hash } }),
      );
      if (process.platform !== "win32") {
        expect(linuxHelper({}, other)).toMatchObject({ own: false });
      }
      // Changed after the release: refused.
      const third = mkdtempSync(join(tmpdir(), "ga-sbx-helper3-"));
      const dir3 = join(third, "vendor", "sandbox", `linux-${arch}`);
      mkdirSync(dir3, { recursive: true });
      writeFileSync(join(dir3, "grafeno-sandbox"), "#!/bin/sh\necho changed\n");
      writeFileSync(
        join(third, "vendor", "sandbox", "manifest.json"),
        JSON.stringify({ files: { [`linux-${arch}/grafeno-sandbox`]: hash } }),
      );
      expect(problemOf(linuxHelper({}, third))).toMatch(/does not match/);
      rmSync(third, { recursive: true, force: true });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(problemOf(linuxHelper({}, join(root, "nowhere")))).toMatch(/not in this installation/);
  });
});

describe("macOS's profile", () => {
  it("closes off writes, the home folder and the network, and opens only what the command needs", () => {
    const profile = new MacEngine({ PATH: "/usr/bin" }).profile(
      {
        writable: ["/Users/me/shop"],
        readable: [],
        network: "none",
        limits: { memoryMb: 1, cpuSeconds: 1, processes: 1, files: 1 },
      },
      { dir: "/sbx", home: "/sbx/home", tmp: "/sbx/tmp" },
    );
    expect(profile).toContain('(deny file-write* (subpath "/"))');
    expect(profile).toContain('(subpath "/Users/me/shop")');
    expect(profile).toMatch(/\(deny file-read\* \(subpath ".+"\)\)/);
    expect(profile).toContain('(deny network-outbound (remote ip "*:*"))');
  });
});

/** An engine that runs commands as they are and reports a full sandbox: for the manager's own logic. */
function fakeEngine(): IsolationEngine {
  return {
    name: "linux",
    probe: () =>
      Promise.resolve({ engine: "linux", available: true, mechanisms: ["fake"], limitations: [] }),
    wrap: (argv) => ({ file: argv[0], args: argv.slice(1) }),
    isolation: () => ({
      engine: "linux",
      files: true,
      network: "none",
      processes: true,
      syscalls: true,
      limits: true,
      mechanisms: ["fake"],
    }),
  };
}

describe("the sandbox manager", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ga-sbx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("makes, lists, inspects, stops, keeps or destroys sandboxes, with nothing of the person's in them", async () => {
    const manager = new SandboxManager({
      dir: join(dir, "sandboxes"),
      engine: fakeEngine(),
      env: {},
    });
    const work = join(dir, "work");
    mkdirSync(work);
    const made = manager.create({ label: "chat", workspace: work });
    expect(existsSync(made.home)).toBe(true);
    expect(existsSync(made.tmp)).toBe(true);
    expect(manager.list().map((s) => s.id)).toEqual([made.id]);
    const tool = runCommandTool(new Workspace(work), {
      shell,
      spawner: manager.spawner(() => made),
    });
    const out = await tool.run({ command: "echo hello" }, { signal });
    expect(out).toMatch(
      /^Exit code 0 \(sandboxed \(files closed off, no network, own processes, limits\)\)\./,
    );
    expect(out).toContain("hello");
    const seen = manager.inspect(made.id);
    expect(seen?.events.join("\n")).toContain('"event":"started"');
    // The command's text never reaches the log.
    expect(seen?.events.join("\n")).not.toContain("echo hello");
    expect(manager.stop(made.id)).toBe(true);
    expect(manager.get(made.id)?.stopped).toBe(true);
    manager.finish(made.id, false);
    expect(manager.get(made.id)).toBeUndefined();
    const kept = manager.create({ label: "task", workspace: work, keep: "failed" });
    manager.finish(kept.id, true);
    expect(manager.get(kept.id)).toBeDefined();
    expect(manager.cleanup()).toBe(1);
    expect(manager.list()).toEqual([]);
  });

  it("sweeps what a dead agent left, and keeps a sandbox whose cleanup failed until it can be done", () => {
    let cleanups = 0;
    let failing = true;
    const engine: IsolationEngine = {
      ...fakeEngine(),
      cleanup: () => {
        cleanups++;
        return !failing;
      },
    };
    const manager = new SandboxManager({ dir: join(dir, "sandboxes"), engine, env: {} });
    const work = join(dir, "work");
    mkdirSync(work);
    const made = manager.create({ label: "chat", workspace: work });
    // Its cleanup fails: the folder stays, marked, and said.
    expect(manager.destroy(made.id)).toBe(false);
    expect(manager.get(made.id)?.cleanupFailed).toBe(true);
    failing = false;
    // Left by an agent that is gone: a record whose maker is no longer running.
    const stale = manager.create({ label: "chat", workspace: work });
    const file = join(stale.dir, "sandbox.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, owner: 2_147_483_000 }));
    const mine = manager.create({ label: "chat", workspace: work });
    const kept = manager.create({ label: "manual", workspace: work, keep: "always" });
    expect(manager.sweep()).toBe(2);
    expect(manager.get(made.id)).toBeUndefined();
    expect(manager.get(stale.id)).toBeUndefined();
    // Its own, and those kept on purpose, stay.
    expect(manager.get(mine.id)).toBeDefined();
    expect(manager.get(kept.id)).toBeDefined();
    expect(cleanups).toBe(3);
  });

  it("without an engine: refused when required, on the computer and said so in auto", async () => {
    const work = join(dir, "work");
    mkdirSync(work);
    const required = new SandboxManager({
      dir: join(dir, "a"),
      engine: new NoEngine("no engine on this test computer"),
      env: { AGENT_SANDBOX: "required" },
    });
    const refused = runCommandTool(new Workspace(work), {
      shell,
      spawner: required.spawner(() => required.create({ label: "chat", workspace: work })),
    });
    await expect(refused.run({ command: "echo x" }, { signal })).rejects.toThrow(
      /required .* no engine on this test computer/,
    );
    const auto = new SandboxManager({
      dir: join(dir, "b"),
      engine: new NoEngine("no engine on this test computer"),
      env: {},
    });
    const open = runCommandTool(new Workspace(work), {
      shell,
      spawner: auto.spawner(() => auto.create({ label: "chat", workspace: work })),
    });
    const out = await open.run({ command: "echo x" }, { signal });
    expect(out).toMatch(/^Exit code 0 \(not sandboxed\)\./);
    const status = await sandboxCommand(["status"], auto, { env: {} });
    expect(status.lines.join("\n")).toContain(
      "Engine: none available here: no engine on this test computer",
    );
    expect(status.lines.join("\n")).toContain("every command's result says so");
  });
});
