import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { checkGrafeno } from "../../src/startup.js";

// Runs against the Grafeno server in the settings (`.env` or the environment).
if (existsSync(".env")) process.loadEnvFile(".env");

describe("a real Grafeno server", () => {
  it("answers, and accepts the agent's key in its namespace", async () => {
    const report = await checkGrafeno(loadConfig());
    expect(report.serverVersion).not.toBe("");
    expect(report.tools).toContain("remember");
    expect(report.tools).toContain("recall");
  });
});
