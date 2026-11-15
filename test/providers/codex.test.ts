import { describe, expect, it } from "vitest";
import { billingRefusal } from "../../src/providers/billing.js";
import {
  CodexAuth,
  CodexCatalog,
  CodexProvider,
  CodexRuntime,
  codexModelName,
  parseModels,
  parseRateLimits,
  type AskAppServer,
  type RunCodex,
} from "../../src/providers/codex.js";

// Outputs recorded from codex-cli 0.169.0 (trimmed), so these tests spend nothing.
const MODELS = `{"models":[
  {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","description":"Latest workhorse model for coding and everyday work.","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}]},
  {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","description":"Frontier intelligence for the most demanding work.","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},
  {"slug":"gpt-6-chat-thinking","display_name":"GPT-6 Chat Thinking","visibility":"hide","supported_reasoning_levels":[{"effort":"low"}]},
  {"slug":"gpt-6-luna","display_name":"GPT-6-Luna","description":"Fast and affordable model for easier tasks.","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}]}
]}`;
const RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794723693 },
    secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1794952126 },
    planType: "plus",
  },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: "RateLimitResetCredit_x" }] },
};

function provider(answers: Record<string, string | Error>, app: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const asked: string[] = [];
  const run: RunCodex = (args) => {
    const key = args.join(" ");
    ran.push(key);
    const answer = answers[key];
    if (answer === undefined || answer instanceof Error) {
      return Promise.reject(answer ?? new Error(`not recorded: ${key}`));
    }
    return Promise.resolve(answer);
  };
  const ask: AskAppServer = (method) => {
    asked.push(method);
    return method in app ? Promise.resolve(app[method]) : Promise.reject(new Error("no answer"));
  };
  return { codex: new CodexProvider(run, ask), ran, asked };
}

describe("CodexProvider", () => {
  it("is ready when signed in with ChatGPT, and says the plan", async () => {
    const { codex } = provider(
      { "--version": "codex-cli 0.169.0\n", "login status": "Logged in using ChatGPT\n" },
      { "account/read": { account: { type: "chatgpt", planType: "plus" } } },
    );
    expect(await codex.status()).toEqual({
      installed: true,
      signedIn: true,
      version: "0.169.0",
      plan: "ChatGPT Plus",
      billing: { kind: "subscription", detail: "Your ChatGPT Plus plan" },
      detail: "Signed in with ChatGPT Plus: answers spend your ChatGPT plan.",
    });
  });

  it("says how to install it, or to sign in", async () => {
    expect((await provider({ "--version": new Error("ENOENT") }).codex.status()).installed).toBe(
      false,
    );
    const signedOut = await provider({
      "--version": "codex-cli 0.169.0",
      "login status": new Error("Not logged in"),
    }).codex.status();
    expect(signedOut).toMatchObject({ installed: true, signedIn: false });
    expect(signedOut.detail).toMatch(/codex login/);
  });

  it("reports a sign-in with an API key as metered: not used without the user's say", async () => {
    const status = await provider({
      "--version": "codex-cli 0.169.0",
      "login status": "Logged in using an API key - sk-***\n",
    }).codex.status();
    expect(status.billing).toEqual({
      kind: "metered",
      detail: "Codex is signed in with an API key",
    });
    expect(status.detail).toMatch(/bills by consumption/);
    expect(JSON.stringify(status)).not.toContain("sk-");
    expect(billingRefusal("codex", status, {})).toContain("AGENT_ALLOW_BILLING=codex");
  });

  it("keeps authentication, model selection and execution apart", () => {
    const { codex, ran, asked } = provider({});
    expect(codex.parts.auth).toBeInstanceOf(CodexAuth);
    expect(codex.parts.catalog).toBeInstanceOf(CodexCatalog);
    expect(codex.parts.runtime).toBeInstanceOf(CodexRuntime);
    expect(codex.tiers).toBe(codex.parts.catalog.tiers);
    // Making a model asks nothing of the sign-in.
    codex.create({ model: "gpt-6-luna", effort: "low" });
    expect([ran.length, asked.length]).toEqual([0, 0]);
  });

  it("lists the models people see, with their exact names and efforts", async () => {
    const { codex, ran } = provider({ "debug models": `WARN something\n${MODELS}` });
    expect(await codex.models()).toEqual([
      // No model given: Codex's own choice.
      { id: "default", name: "Auto", hint: "Codex's own choice" },
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        hint: "Latest workhorse model for coding and everyday work.",
      },
      {
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        hint: "Frontier intelligence for the most demanding work.",
      },
      { id: "gpt-6-luna", name: "GPT-6-Luna", hint: "Fast and affordable model for easier tasks." },
    ]);
    await codex.models();
    expect(ran.filter((r) => r === "debug models")).toHaveLength(1); // read once
    expect(codex.efforts("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(codex.efforts("gpt-6-astra")).toEqual(["low", "high"]);
    expect(codex.efforts("unknown")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("reads the plan's real usage from the app-server, and never touches reset credits", async () => {
    const { codex, asked } = provider({}, { "account/rateLimits/read": RATE_LIMITS });
    const usage = await codex.usage();
    expect(usage?.limits.map((l) => [l.label, l.used])).toEqual([
      ["5 hours", 0.12],
      ["Week", 0.22],
    ]);
    expect(usage?.note).toBe("Your Plus plan");
    expect(asked).toEqual(["account/rateLimits/read"]);
  });

  it("says nothing about usage when the app-server does not answer", async () => {
    expect(await provider({}).codex.usage()).toBeUndefined();
  });

  it("maps tiers to models without naming them anywhere else", () => {
    const { codex } = provider({});
    expect(codex.tiers.light[0]).toBe("gpt-6-luna");
    expect(codex.tiers.deep[0]).toBe("gpt-6-astra");
  });
});

describe("parsing", () => {
  it("leaves hidden models out", () => {
    expect(parseModels(MODELS).map((m) => m.slug)).not.toContain("gpt-6-chat-thinking");
    expect(parseModels("no json here")).toEqual([]);
  });

  it("names windows by their length", () => {
    expect(
      parseRateLimits({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 1440 } } }),
    ).toEqual([{ label: "Day", used: 0.5 }]);
    expect(parseRateLimits(null)).toEqual([]);
  });

  it("writes model names the way people read them", () => {
    expect(codexModelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(codexModelName("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(codexModelName("o9")).toBe("o9");
  });
});
