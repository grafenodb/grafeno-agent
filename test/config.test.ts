import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULTS, describeConfig, loadConfig, maskSecret } from "../src/config.js";

const KEY = "gk_test_0123456789abcdef";

describe("loadConfig", () => {
  it("uses the defaults when only the key is set", () => {
    expect(loadConfig({ GRAFENO_AGENT_KEY: KEY })).toEqual({
      grafenoMode: "external",
      grafenoUrl: DEFAULTS.grafenoUrl,
      agentKey: KEY,
      namespace: DEFAULTS.namespace,
      sharedNamespace: DEFAULTS.namespace,
      model: DEFAULTS.model,
      embedder: DEFAULTS.embedder,
      palace: DEFAULTS.palace,
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
        AGENT_PROJECT: "demo",
        AGENT_EMBEDDER: "none",
      }),
    ).toEqual({
      grafenoUrl: "https://grafeno.example:7810",
      agentKey: KEY,
      namespace: "work.agent-1",
      sharedNamespace: "work.agent-1",
      model: "fake",
      claudeModel: "sonnet",
      project: "demo",
      embedder: "none",
      grafenoMode: "external",
      palace: "shared",
    });
  });

  it("refuses an embedder it does not know", () => {
    expect(() => loadConfig({ GRAFENO_AGENT_KEY: KEY, AGENT_EMBEDDER: "gpt" })).toThrow(
      /AGENT_EMBEDDER must be one of e5-small, none/,
    );
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

describe("AGENT_PALACE", () => {
  it("takes own, and refuses what it does not know", () => {
    expect(loadConfig({ GRAFENO_AGENT_KEY: KEY, AGENT_PALACE: "own" }).palace).toBe("own");
    expect(() => loadConfig({ GRAFENO_AGENT_KEY: KEY, AGENT_PALACE: "mine" })).toThrow(
      /AGENT_PALACE must be one of shared, own/,
    );
  });
});

describe("GRAFENO_MODE", () => {
  it("uses the included Grafeno's address when included, whatever GRAFENO_URL says", () => {
    const config = loadConfig({
      GRAFENO_AGENT_KEY: KEY,
      GRAFENO_MODE: "included",
      GRAFENO_URL: "http://elsewhere:7810",
    });
    expect(config.grafenoMode).toBe("included");
    expect(config.grafenoUrl).toBe("http://127.0.0.1:7811");
    expect(() => loadConfig({ GRAFENO_AGENT_KEY: KEY, GRAFENO_MODE: "cloud" })).toThrow(
      /GRAFENO_MODE must be one of external, included/,
    );
  });
});

describe("AGENT_MEMORY_BUDGET", () => {
  it("sets memory limits, and names a wrong one", () => {
    expect(
      loadConfig({ GRAFENO_AGENT_KEY: KEY, AGENT_MEMORY_BUDGET: "checkpoint=300,callsPerTurn=4" })
        .memoryLimits,
    ).toEqual({ checkpoint: 300, callsPerTurn: 4 });
    expect(loadConfig({ GRAFENO_AGENT_KEY: KEY }).memoryLimits).toBeUndefined();
    expect(() => loadConfig({ GRAFENO_AGENT_KEY: KEY, AGENT_MEMORY_BUDGET: "tokens=5" })).toThrow(
      /unknown limit "tokens"/,
    );
  });
});
