import { describe, expect, it } from "vitest";
import {
  claudeModelName,
  ClaudeCodeProvider,
  parseUsage,
  type RunClaude,
} from "../../src/providers/claude-code.js";
import { includedAsset } from "../../src/grafeno/included.js";

/** A `claude` that answers from a table: what each run of it prints. */
function fakeClaude(answers: (args: readonly string[]) => string): {
  run: RunClaude;
  seen: string[][];
} {
  const seen: string[][] = [];
  return {
    seen,
    run: (args) => {
      seen.push([...args]);
      try {
        return Promise.resolve(answers(args));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

const json = (result: string) => JSON.stringify({ result, total_cost_usd: 0 });

describe("ClaudeCodeProvider", () => {
  it("says it is installed and signed in, with the plan, never the e-mail", async () => {
    const { run } = fakeClaude((args) => {
      if (args[0] === "--version") return "2.1.325 (Claude Code)\n";
      if (args[0] === "auth") {
        return JSON.stringify({
          loggedIn: true,
          subscriptionType: "pro",
          email: "someone@example.com",
        });
      }
      throw new Error("unexpected");
    });
    const status = await new ClaudeCodeProvider(run).status();
    expect(status).toMatchObject({
      installed: true,
      signedIn: true,
      version: "2.1.325",
      plan: "Claude Pro",
    });
    expect(JSON.stringify(status)).not.toContain("example.com");
  });

  it("says when Claude Code is missing or not signed in", async () => {
    const missing = fakeClaude(() => {
      throw new Error("ENOENT");
    });
    expect(await new ClaudeCodeProvider(missing.run).status()).toMatchObject({ installed: false });
    const out = fakeClaude((args) =>
      args[0] === "--version" ? "2.1.325" : JSON.stringify({ loggedIn: false }),
    );
    const status = await new ClaudeCodeProvider(out.run).status();
    expect(status).toMatchObject({ installed: true, signedIn: false });
    expect(status.detail).toContain("/login");
  });

  it("names each model exactly, as Claude Code's own /model says it", async () => {
    const { run, seen } = fakeClaude((args) => {
      const alias = args.find((a) => a.startsWith("--model="))?.slice(8);
      const names: Record<string, string> = {
        haiku: "Haiku 5.5",
        sonnet: "Sonnet 5.5",
        opus: "Opus 5.5",
        fable: "Fable 5.2",
      };
      return json(
        `Current model: \`${alias ? (names[alias] ?? alias) : "Opus 5.5"}\`\nUsage: /model <name>.`,
      );
    });
    const models = await new ClaudeCodeProvider(run).models();
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ["default", "Opus 5.5"],
      ["haiku", "Haiku 5.5"],
      ["sonnet", "Sonnet 5.5"],
      ["opus", "Opus 5.5"],
      ["fable", "Fable 5.2"],
    ]);
    // Built-in commands, headless: they answer locally.
    expect(seen.every((args) => args[0] === "-p" && args[1] === "/model")).toBe(true);
  });

  it("reads the plan's real usage from Claude Code's /usage", async () => {
    const { run } = fakeClaude(() =>
      json(
        "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 91% used · resets Nov 14, 1:19pm (America/Guayaquil)\nCurrent week (all models): 59% used · resets Nov 17, 11:59am (America/Guayaquil)\nCurrent week (Fable): 0% used · resets Nov 17, 11:59am (America/Guayaquil)\n",
      ),
    );
    const usage = await new ClaudeCodeProvider(run).usage();
    expect(usage?.limits).toEqual([
      { label: "Session", used: 0.91, resets: "Nov 14, 1:19pm (America/Guayaquil)" },
      { label: "Week (all models)", used: 0.59, resets: "Nov 17, 11:59am (America/Guayaquil)" },
      { label: "Week (Fable)", used: 0, resets: "Nov 17, 11:59am (America/Guayaquil)" },
    ]);
    expect(usage?.note).toBe("Your Claude subscription");
  });

  it("says nothing about usage when Claude Code cannot", async () => {
    const { run } = fakeClaude(() => json("Unknown command"));
    expect(await new ClaudeCodeProvider(run).usage()).toBeUndefined();
    expect(parseUsage("")).toEqual([]);
  });

  it("turns model ids into their exact names", () => {
    expect(claudeModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(claudeModelName("claude-haiku-5-5-20261001")).toBe("Haiku 5.5");
    expect(claudeModelName("claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5 (1M)");
  });
});

describe("the included Grafeno", () => {
  it("has an official build for Windows and Linux, and none for macOS", () => {
    expect(includedAsset("win32", "x64")?.file).toBe("grafeno-x86_64-pc-windows-msvc.zip");
    expect(includedAsset("linux", "x64")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(includedAsset("linux", "arm64")).toBeDefined();
    expect(includedAsset("darwin", "arm64")).toBeUndefined();
  });
});
