import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/model/index.js";
import { autoAllows, decide, settingsPermissionMode } from "../../src/agent/permissions.js";
import { Policy } from "../../src/orchestrator/policy.js";

const ask = { permission: "ask" as const, reason: "it writes" };
const tool = (name: string) => ({ name });

describe("permission modes", () => {
  it("ask asks, skip runs, and never stays never in every mode", () => {
    for (const mode of ["ask", "auto", "skip"] as const) {
      expect(
        decide(mode, tool("run_command"), { command: "x" }, { permission: "never", reason: "no" }),
      ).toMatchObject({ verdict: "never" });
      expect(decide(mode, tool("read_file"), {}, { permission: "free" })).toMatchObject({
        verdict: "allow",
      });
    }
    expect(decide("ask", tool("write_file"), {}, ask)).toMatchObject({ verdict: "ask" });
    expect(decide("skip", tool("delete_file"), {}, ask)).toMatchObject({ verdict: "allow" });
    expect(decide("skip", tool("github_create_pr"), {}, ask)).toMatchObject({ verdict: "allow" });
  });

  it("auto lets project changes and checks run, and asks for what deletes, publishes, installs or reaches outside", () => {
    const allowed = (name: string, input: Record<string, unknown> = {}) =>
      autoAllows(tool(name), input).allow;
    expect(allowed("write_file")).toBe(true);
    expect(allowed("multi_edit")).toBe(true);
    expect(allowed("move_file")).toBe(true);
    expect(allowed("delete_file")).toBe(false);
    expect(allowed("run_command", { command: "npm test" })).toBe(true);
    expect(allowed("run_command", { command: "node --test test/" })).toBe(true);
    expect(allowed("run_command", { command: "git commit -m 'x'" })).toBe(true);
    expect(allowed("run_command", { command: "mkdir -p src/utils" })).toBe(true);
    expect(allowed("run_command", { command: "git push origin main" })).toBe(false);
    expect(allowed("run_command", { command: "npm install -g typescript" })).toBe(false);
    expect(allowed("run_command", { command: "winget install Git.Git" })).toBe(false);
    expect(allowed("run_command", { command: "npm test && git push" })).toBe(false);
    expect(allowed("run_command", { command: "some-unknown-tool --flag" })).toBe(false);
    expect(allowed("start_process", { command: "npm run dev" })).toBe(true);
    expect(allowed("github_comment")).toBe(false);
    expect(allowed("mcp_files_write")).toBe(false);
    expect(decide("auto", tool("write_file"), {}, ask).reason).toMatch(/^automatic:/);
  });

  it("the agent-wide mode is a setting, ask when unset or unknown", () => {
    expect(settingsPermissionMode({})).toBe("ask");
    expect(settingsPermissionMode({ AGENT_PERMISSIONS: "Auto" })).toBe("auto");
    expect(settingsPermissionMode({ AGENT_PERMISSIONS: "everything" })).toBe("ask");
  });
});

describe("a run's workers and the person's permissions", () => {
  const call = (input: Record<string, unknown>): ToolCall => ({
    id: "c",
    name: "run_command",
    input,
  });
  const command = { name: "run_command", describe: undefined } as never;

  it("skip lets what the policy would ask run with nobody to ask; never stays never", async () => {
    const asked = new Policy({ mode: "controlled" }).approver({ task: "t" });
    expect(await asked(call({ command: "git push" }), command, ask)).toBe(false);
    const skipping = new Policy({ mode: "controlled", permissions: "skip" }).approver({
      task: "t",
    });
    expect(await skipping(call({ command: "git push" }), command, ask)).toBe(true);
    expect(
      await skipping(call({ command: "sudo x" }), command, { permission: "never", reason: "no" }),
    ).toBe(false);
  });

  it("auto lets only what its rules find safe run", async () => {
    const auto = new Policy({ mode: "supervised", permissions: "auto" }).approver({ task: "t" });
    expect(await auto(call({ command: "npm test" }), command, ask)).toBe(true);
    expect(await auto(call({ command: "git push" }), command, ask)).toBe(false);
  });
});
