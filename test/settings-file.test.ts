import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSettings, settingsPath, settingsTemplate } from "../src/settings-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ga-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settingsPath", () => {
  it("uses GRAFENO_AGENT_CONFIG when set", () => {
    expect(settingsPath({ GRAFENO_AGENT_CONFIG: "/x/agent.env" })).toBe("/x/agent.env");
  });

  it("lives in the user's own settings folder", () => {
    const path = settingsPath({
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      XDG_CONFIG_HOME: "/home/u/.config",
    });
    expect(path.replace(/\\/g, "/")).toMatch(
      /(AppData\/Roaming|\.config)\/grafeno-agent\/config\.env$/,
    );
  });
});

describe("initSettings", () => {
  it("writes the template once, and never overwrites", async () => {
    const path = join(dir, "nested", "config.env");
    expect(initSettings(path)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).toContain("GRAFENO_AGENT_KEY=");
    expect(text).toBe(settingsTemplate());
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(initSettings(path)).toBe(false);
  });

  it("starts with no key in it", () => {
    expect(settingsTemplate()).toMatch(/^GRAFENO_AGENT_KEY=$/m);
  });
});
