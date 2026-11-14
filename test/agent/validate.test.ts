import { describe, expect, it } from "vitest";
import { validate } from "../../src/agent/validate.js";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    lines: { type: "integer" },
    mode: { enum: ["read", "write"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("validate", () => {
  it("accepts arguments that fit", () => {
    expect(validate({ path: "a.ts", lines: 3, mode: "read", tags: ["x"] }, schema)).toEqual([]);
  });

  it("says every problem", () => {
    expect(validate({ lines: 1.5, mode: "delete", tags: [1], extra: true }, schema)).toEqual([
      "input.path is required",
      "input.lines must be an integer",
      'input.mode must be one of "read", "write"',
      "input.tags[0] must be a string",
      "input.extra is not an argument of this tool",
    ]);
  });

  it("rejects what is not an object", () => {
    expect(validate("a.ts", schema)).toEqual(["input must be an object"]);
  });
});
