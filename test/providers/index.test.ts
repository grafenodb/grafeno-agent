import { describe, expect, it } from "vitest";
import { TASK_KINDS } from "../../src/orchestrator/plan.js";
import {
  allProviders,
  chosenProviders,
  providerForKinds,
  isAuto,
  providerIds,
} from "../../src/providers/index.js";

describe("choosing providers", () => {
  it("uses every ready provider (Auto) unless AGENT_PROVIDERS says otherwise", () => {
    // Nothing set: Auto, every known provider (the registry keeps the ready ones).
    expect(providerIds(undefined)).toEqual(["claude-code", "codex", "gemini"]);
    expect(providerIds(" ")).toEqual(["claude-code", "codex", "gemini"]);
    expect(isAuto(undefined)).toBe(true);
    expect(isAuto("")).toBe(true);
    expect(isAuto("claude-code")).toBe(false);
    expect(chosenProviders({}).map((p) => p.id)).toEqual(["claude-code", "codex", "gemini"]);
    expect(chosenProviders({ AGENT_PROVIDERS: "claude-code" }).map((p) => p.id)).toEqual([
      "claude-code",
    ]);
  });

  it("keeps the order given, once each, and refuses one it does not know", () => {
    expect(providerIds("codex, claude-code, codex")).toEqual(["codex", "claude-code"]);
    expect(() => providerIds("claude-code,gpt-api")).toThrow(/Unknown provider gpt-api/);
  });

  it("shows every known provider in /connect, the chosen ones first", () => {
    expect(allProviders({ AGENT_PROVIDERS: "codex" }).map((p) => p.id)).toEqual([
      "codex",
      "claude-code",
      "gemini",
    ]);
  });

  it("reads which provider takes which kind of task", () => {
    expect(providerForKinds("tests=codex, docs=codex", TASK_KINDS)).toEqual({
      tests: "codex",
      docs: "codex",
    });
    expect(() => providerForKinds("poems=codex", TASK_KINDS)).toThrow(/kind=provider/);
    expect(() => providerForKinds("tests=openai-api", TASK_KINDS)).toThrow(/kind=provider/);
  });
});
