import { describe, expect, it } from "vitest";
import { applyNoColor } from "../../src/tui/colors.js";

describe("NO_COLOR", () => {
  it("is told to the terminal library in its words, unless FORCE_COLOR was set on purpose", () => {
    const off: Record<string, string | undefined> = { NO_COLOR: "1" };
    applyNoColor(off);
    expect(off.FORCE_COLOR).toBe("0");
    const forced: Record<string, string | undefined> = { NO_COLOR: "1", FORCE_COLOR: "3" };
    applyNoColor(forced);
    expect(forced.FORCE_COLOR).toBe("3");
    // An empty NO_COLOR is not set (no-color.org).
    const empty: Record<string, string | undefined> = { NO_COLOR: "" };
    applyNoColor(empty);
    expect(empty.FORCE_COLOR).toBeUndefined();
  });
});
