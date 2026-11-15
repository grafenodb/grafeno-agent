import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { CodexModel, codexCommand } from "../model/codex.js";
import { resilient } from "../model/index.js";
import type {
  ModelChoice,
  ModelOption,
  Provider,
  ProviderStatus,
  ProviderUsage,
  UsageLimit,
} from "./types.js";

/** Runs `codex` with these arguments and gives what it printed. */
export type RunCodex = (args: readonly string[], timeoutMs: number) => Promise<string>;

/**
 * Asks Codex's official app-server one question (JSON-RPC over stdio) and
 * gives the answer: what Codex's own interface asks to show the plan.
 */
export type AskAppServer = (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

function runCodex(): RunCodex {
  const { command, prefix } = codexCommand();
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...prefix, ...args],
        // A neutral folder: no project's settings apply.
        { cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        // Some answers (`login status`) come on stderr: both are given.
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`, { cause: error }));
          else resolve(`${stdout}${stderr}`);
        },
      );
    });
}

function askAppServer(): AskAppServer {
  const { command, prefix } = codexCommand();
  return (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...prefix, "app-server"], {
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const finish = (error: Error | undefined, value?: unknown) => {
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error(`Codex's app-server did not answer ${method}`));
      }, timeoutMs);
      child.on("error", (error) => {
        finish(error);
      });
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method, params });
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message ?? `${method} failed`));
          else finish(undefined, message.result);
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "grafeno-agent", version: "0" } },
      });
    });
}

/** What `codex debug models` gives for a model. */
interface CodexModelInfo {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: { effort?: string }[];
}

/** Efforts the agent offers, lowest first: Codex's "ultra" delegates tasks on its own, so it is left out. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Codex through the user's own Codex CLI and their ChatGPT plan. Everything
 * here asks the official `codex` program: `--version`, `login status`,
 * `debug models`, and its app-server's `account/read` and
 * `account/rateLimits/read`, which answer without spending any of the plan.
 * Credentials are never read, and a rate-limit reset credit is never used.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly name = "Codex (ChatGPT)";
  readonly signIn = "Run `codex login` in a terminal and sign in with ChatGPT (your subscription).";
  readonly tiers = {
    deep: ["gpt-6-astra", "gpt-6.1-sol"],
    standard: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol"],
    light: ["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra"],
  } as const;
  readonly features = {
    agentTools: true,
    streaming: true,
    // Each turn resumes the thread: a cancelled one leaves it as it was.
    keepsConversation: true,
    usageReport: true,
    nonInteractive: true,
  } as const;
  #catalog: Promise<CodexModelInfo[]> | undefined;
  #efforts = new Map<string, readonly string[]>();

  constructor(
    private readonly run: RunCodex = runCodex(),
    private readonly ask: AskAppServer = askAppServer(),
  ) {}

  async status(): Promise<ProviderStatus> {
    let version: string;
    try {
      version = (await this.run(["--version"], 15_000)).trim().replace(/^codex-cli\s+/, "");
    } catch {
      return {
        installed: false,
        signedIn: false,
        detail: "Codex was not found. Install it (npm install -g @openai/codex), then sign in.",
      };
    }
    let login: string;
    try {
      login = await this.run(["login", "status"], 15_000);
    } catch (error) {
      // `login status` exits non-zero when nobody is signed in.
      login = error instanceof Error ? error.message : "";
    }
    if (!/logged in using/i.test(login) || /not logged in/i.test(login)) {
      return { installed: true, signedIn: false, version, detail: this.signIn };
    }
    if (/api key/i.test(login)) {
      // Signed in with an API key: that bills per token, which the agent does not use.
      return {
        installed: true,
        signedIn: false,
        version,
        detail:
          "Codex is signed in with an API key, which bills per token. Sign in with ChatGPT instead (codex login).",
      };
    }
    const plan = await this.#plan();
    return {
      installed: true,
      signedIn: true,
      version,
      ...(plan === undefined ? {} : { plan }),
      detail: `Signed in with ${plan ?? "ChatGPT"}: answers spend your ChatGPT plan.`,
    };
  }

  async models(): Promise<readonly ModelOption[]> {
    const catalog = await this.#models();
    return catalog.map((m) => ({
      id: m.slug ?? "",
      name: m.display_name ?? m.slug ?? "",
      ...(m.description ? { hint: m.description } : {}),
    }));
  }

  efforts(model?: string): readonly string[] {
    if (model !== undefined) {
      const known = this.#efforts.get(model);
      if (known) return known;
    }
    return EFFORTS;
  }

  async usage(): Promise<ProviderUsage | undefined> {
    let answer: unknown;
    try {
      answer = await this.ask("account/rateLimits/read", null, 20_000);
    } catch {
      return undefined;
    }
    const limits = parseRateLimits(answer);
    if (limits.length === 0) return undefined;
    const plan = (answer as { rateLimits?: { planType?: string } } | undefined)?.rateLimits
      ?.planType;
    return {
      limits,
      at: new Date(),
      ...(plan ? { note: `Your ${planName(plan)} plan` } : {}),
    };
  }

  modelName(id: string): string {
    return codexModelName(id);
  }

  create(choice: ModelChoice) {
    return resilient(
      new CodexModel({
        ...(choice.model === undefined ? {} : { model: choice.model }),
        ...(choice.effort === undefined ? {} : { effort: choice.effort }),
      }),
    );
  }

  /** The models Codex lists (hidden ones left out), read once. */
  #models(): Promise<CodexModelInfo[]> {
    this.#catalog ??= this.run(["debug", "models"], 30_000)
      .then((output) => {
        const models = parseModels(output);
        for (const m of models) {
          if (m.slug) this.#efforts.set(m.slug, effortsOf(m));
        }
        return models;
      })
      .catch(() => []);
    return this.#catalog;
  }

  async #plan(): Promise<string | undefined> {
    try {
      const answer = (await this.ask("account/read", {}, 20_000)) as {
        account?: { type?: string; planType?: string };
      };
      const plan = answer.account?.planType;
      return plan ? `ChatGPT ${planName(plan)}` : undefined;
    } catch {
      return undefined;
    }
  }
}

/** The models of `codex debug models` that it lists to people. */
export function parseModels(output: string): CodexModelInfo[] {
  const start = output.indexOf("{");
  if (start < 0) return [];
  try {
    const data = JSON.parse(output.slice(start)) as { models?: CodexModelInfo[] };
    return (data.models ?? []).filter((m) => m.visibility !== "hide" && typeof m.slug === "string");
  } catch {
    return [];
  }
}

function effortsOf(model: CodexModelInfo): readonly string[] {
  const offered = new Set((model.supported_reasoning_levels ?? []).map((l) => l.effort));
  return EFFORTS.filter((effort) => offered.has(effort));
}

/** The plan's windows from `account/rateLimits/read`: "5 hours", "Week", each used 0–1. */
export function parseRateLimits(answer: unknown): UsageLimit[] {
  const limits = (
    answer as {
      rateLimits?: Record<
        string,
        { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
      >;
    } | null
  )?.rateLimits;
  if (!limits) return [];
  const out: UsageLimit[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = limits[key];
    if (!window || typeof window.usedPercent !== "number") continue;
    out.push({
      label: windowLabel(window.windowDurationMins),
      used: window.usedPercent / 100,
      ...(typeof window.resetsAt === "number"
        ? { resets: new Date(window.resetsAt * 1000).toLocaleString() }
        : {}),
    });
  }
  return out;
}

function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return "Window";
  if (minutes % 10_080 === 0)
    return minutes === 10_080 ? "Week" : `${String(minutes / 10_080)} weeks`;
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "Day" : `${String(minutes / 1_440)} days`;
  if (minutes % 60 === 0) return `${String(minutes / 60)} hours`;
  return `${String(minutes)} minutes`;
}

function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** `gpt-6.1-sol` → "GPT-6.1 Sol". */
export function codexModelName(id: string): string {
  const match = /^gpt-([\d.]+)-(.+)$/i.exec(id);
  if (!match) return id;
  const family = (match[2] ?? "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `GPT-${match[1] ?? ""} ${family}`;
}
