import { describe, expect, it } from "vitest";
import { TASK_KINDS } from "../../src/orchestrator/plan.js";
import {
  allProviders,
  API_KEY_PROVIDERS,
  autoMembers,
  chosenProviders,
  providerForKinds,
  isAuto,
  providerIds,
} from "../../src/providers/index.js";

describe("choosing providers", () => {
  it("uses Auto unless AGENT_PROVIDERS says otherwise, with the official CLIs by default", () => {
    // Nothing set: Auto, with what it includes (the registry keeps the ready ones).
    expect(providerIds(undefined, {})).toEqual(["claude-code", "codex"]);
    expect(providerIds(" ", {})).toEqual(["claude-code", "codex"]);
    expect(isAuto(undefined)).toBe(true);
    expect(isAuto("")).toBe(true);
    expect(isAuto("claude-code")).toBe(false);
    expect(chosenProviders({}).map((p) => p.id)).toEqual(["claude-code", "codex"]);
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
      "openrouter",
    ]);
  });

  it("lets the user choose what Auto includes; an API-key provider only when named", () => {
    expect(autoMembers({})).toEqual(["claude-code", "codex"]);
    expect(API_KEY_PROVIDERS).toEqual(["gemini", "openrouter"]);
    expect(autoMembers({ AGENT_AUTO_PROVIDERS: " claude-code , gemini, gemini " })).toEqual([
      "claude-code",
      "gemini",
    ]);
    expect(() => autoMembers({ AGENT_AUTO_PROVIDERS: "claude-code,gpt" })).toThrow(
      /unknown provider: gpt/,
    );
    // A named provider's list is the user's, Auto or not.
    expect(providerIds("openrouter", {})).toEqual(["openrouter"]);
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
