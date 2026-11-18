import { describe, expect, it } from "vitest";
import {
  checkSetting,
  settingsTool,
  type SettingKey,
  type SettingsPort,
  type SettingsSnapshot,
} from "../../src/app/settings-tool.js";

const now: SettingsSnapshot = {
  mode: "specific",
  provider: "codex",
  model: "default",
  effort: "medium",
  auto_providers: ["codex", "claude-code"],
  leader: "",
  providers: [
    { id: "codex", state: "available" },
    { id: "claude-code", state: "available" },
    { id: "gemini", state: "configured" },
  ],
  models: ["default", "luna", "terra"],
  efforts: ["low", "medium", "high"],
};

function port(applied: string[] = []): SettingsPort {
  return {
    read: () => now,
    apply: (key: SettingKey, value) => {
      applied.push(`${key}=${JSON.stringify(value)}`);
      return Promise.resolve(`done: ${key}`);
    },
  };
}

const context = { signal: new AbortController().signal };

describe("the agent's settings, for a model", () => {
  it("reads them freely; a change always asks the person first", async () => {
    const tool = settingsTool(() => port());
    expect(tool.permission?.({ action: "get" }).permission).toBe("free");
    expect(tool.permission?.({ action: "set", key: "model", value: "luna" }).permission).toBe(
      "ask",
    );
    expect(tool.describe?.({ action: "set", key: "model", value: "luna" })).toBe(
      'Change the agent\'s settings: model = "luna"',
    );
    const reply = await tool.run({ action: "get" }, context);
    const read = JSON.parse(typeof reply === "string" ? reply : reply.text) as SettingsSnapshot;
    expect(read.provider).toBe("codex");
    expect(read.models).toEqual(["default", "luna", "terra"]);
  });

  it("checks each change against what exists now; applies it through the interface", async () => {
    const applied: string[] = [];
    const tool = settingsTool(() => port(applied));
    expect(await tool.run({ action: "set", key: "model", value: "luna" }, context)).toBe(
      "done: model",
    );
    expect(await tool.run({ action: "set", key: "model", value: "opus" }, context)).toContain(
      "is not one of codex's models",
    );
    expect(await tool.run({ action: "set", key: "provider", value: "nope" }, context)).toContain(
      "Unknown provider nope",
    );
    expect(await tool.run({ action: "set", key: "mode", value: "turbo" }, context)).toBe(
      'mode is "auto" or "specific".',
    );
    expect(applied).toEqual(['model="luna"']);
  });

  it("never changes keys, billing, permissions, the sandbox or Grafeno", () => {
    for (const key of ["api_key", "AGENT_ALLOW_BILLING", "permissions", "sandbox", "grafeno_url"]) {
      expect(checkSetting(key, "x", now)).toContain("are the person's to change");
    }
  });

  it("Auto's members are known ones, at least one; the leader is one of them", () => {
    expect(checkSetting("auto_providers", [], now)).toBe("Auto needs at least one provider.");
    expect(checkSetting("auto_providers", ["codex", "zzz"], now)).toBe("Unknown providers: zzz.");
    expect(checkSetting("auto_providers", ["gemini"], now)).toBeUndefined();
    expect(checkSetting("leader", "gemini/pro", now)).toContain("must be one of Auto's providers");
    expect(checkSetting("leader", "codex/terra", now)).toBeUndefined();
    expect(checkSetting("leader", "", now)).toBeUndefined();
    expect(checkSetting("effort", "max", now)).toContain("is not one of codex's efforts");
    expect(checkSetting("provider", "none", now)).toBeUndefined();
  });
});
