import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULTS, describeConfig, loadConfig, maskSecret } from "../src/config.js";

const KEY = "gk_test_0123456789abcdef";

describe("loadConfig", () => {
  it("uses the defaults when only the key is set", () => {
    expect(loadConfig({ GRAFENO_AGENT_KEY: KEY })).toEqual({
      grafenoUrl: DEFAULTS.grafenoUrl,
      agentKey: KEY,
      namespace: DEFAULTS.namespace,
      model: DEFAULTS.model,
    });
  });

  it("reads every setting and trims a trailing slash from the URL", () => {
    expect(
      loadConfig({
        GRAFENO_URL: "https://grafeno.example:7810/",
        GRAFENO_AGENT_KEY: ` ${KEY} `,
        GRAFENO_NAMESPACE: "work.agent-1",
        AGENT_MODEL: "fake",
        CLAUDE_MODEL: "sonnet",
      }),
    ).toEqual({
      grafenoUrl: "https://grafeno.example:7810",
      agentKey: KEY,
      namespace: "work.agent-1",
      model: "fake",
      claudeModel: "sonnet",
    });
  });

  it("treats empty values as unset", () => {
    expect(
      loadConfig({ GRAFENO_AGENT_KEY: KEY, GRAFENO_URL: "", AGENT_MODEL: "  " }),
    ).toMatchObject({ grafenoUrl: DEFAULTS.grafenoUrl, model: DEFAULTS.model });
  });

  it("reports every problem at once", () => {
    let caught: unknown;
    try {
      loadConfig({ GRAFENO_URL: "ftp://x", GRAFENO_NAMESPACE: "bad name" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/GRAFENO_URL must be http/);
    expect(problems.join("\n")).toMatch(/GRAFENO_AGENT_KEY is not set/);
    expect(problems.join("\n")).toMatch(/GRAFENO_NAMESPACE/);
  });

  it("rejects a URL that does not parse", () => {
    expect(() => loadConfig({ GRAFENO_AGENT_KEY: KEY, GRAFENO_URL: "not a url" })).toThrow(
      /not a URL/,
    );
  });
});

describe("describeConfig", () => {
  it("never prints the key", () => {
    const text = describeConfig(loadConfig({ GRAFENO_AGENT_KEY: KEY }));
    expect(text).not.toContain(KEY);
    expect(text).toContain(maskSecret(KEY));
  });

  it("masks short secrets entirely", () => {
    expect(maskSecret("abc")).toBe("********");
  });
});
