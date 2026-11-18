import { describe, expect, it } from "vitest";
import { autoVerdict, type AutoMember } from "../../src/app/auto-rules.js";

const member = (id: string, state: AutoMember["state"], why = ""): AutoMember => ({
  id,
  name: id,
  state,
  why,
});

describe("whether General Auto can run", () => {
  it("never with no member, nor with none ready: it says why each is left out", () => {
    expect(autoVerdict([]).allowed).toBe(false);
    const none = autoVerdict([
      member("codex", "unavailable", "switched off"),
      member("gemini", "configured"),
      member("claude-api", "connected"),
    ]);
    expect(none.allowed).toBe(false);
    expect(none.message).toContain("Auto stays off: none of its providers is ready");
    expect(none.message).toContain("codex: switched off");
    expect(none.message).toContain("gemini: not signed in");
    expect(none.message).toContain("claude-api: held back (it bills per token, not allowed)");
  });

  it("with some ready: on, and what it leaves out is said", () => {
    const some = autoVerdict([member("codex", "available"), member("gemini", "error")]);
    expect(some.allowed).toBe(true);
    expect(some.ready).toEqual(["codex"]);
    expect(some.message).toContain("across 1 ready provider (codex)");
    expect(some.message).toContain("Left out for now: gemini: it failed to answer.");
  });

  it("says when the leader is not in Auto or not ready; never blocks Auto for it", () => {
    const members = [member("codex", "available"), member("gemini", "configured")];
    expect(autoVerdict(members, "codex/luna").leader).toBeUndefined();
    const outside = autoVerdict(members, "claude-code/opus");
    expect(outside.allowed).toBe(true);
    expect(outside.leader).toContain("is not in Auto");
    expect(autoVerdict(members, "gemini/pro").leader).toContain("is not ready (not signed in)");
  });
});
