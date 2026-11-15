import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { createModel } from "../model/index.js";
import type {
  ModelChoice,
  ModelOption,
  Provider,
  ProviderStatus,
  ProviderUsage,
  UsageLimit,
} from "./types.js";

/** The aliases Claude Code takes for the latest of each family, and what they are for. */
const FAMILIES = [
  { id: "haiku", hint: "fastest, spends the least of your plan" },
  { id: "sonnet", hint: "balanced" },
  { id: "opus", hint: "most capable" },
  { id: "fable", hint: "newest family" },
] as const;

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Runs `claude` with these arguments and gives what it printed. */
export type RunClaude = (args: readonly string[], timeoutMs: number) => Promise<string>;

function runClaude(command: string): RunClaude {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        // A neutral folder: no project's settings apply.
        { cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(new Error(error.message, { cause: error }));
          else resolve(stdout);
        },
      );
    });
}

/** What a headless built-in command answered (they run locally: no tokens, no cost). */
function resultOf(output: string): string {
  try {
    const data = JSON.parse(output) as { result?: unknown };
    return typeof data.result === "string" ? data.result : "";
  } catch {
    return "";
  }
}

/**
 * Claude through the user's own Claude Code. Everything here asks the
 * official `claude` program: its version, `auth status`, and its built-in
 * `/model` and `/usage` commands, which answer locally without spending any
 * of the plan. Credentials are never read.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code";
  readonly name = "Claude (Claude Code)";
  readonly signIn =
    "Run `claude` in a terminal and sign in with /login (your Claude subscription).";
  /** Claude Code's aliases always name the latest of each family. */
  readonly tiers = {
    deep: ["opus", "fable", "sonnet"],
    standard: ["sonnet", "opus"],
    light: ["haiku", "sonnet"],
  } as const;
  readonly features = {
    agentTools: true,
    streaming: true,
    // Cancelling stops Claude Code, and the conversation with it.
    keepsConversation: false,
    usageReport: true,
    nonInteractive: true,
  } as const;
  #models: Promise<readonly ModelOption[]> | undefined;

  constructor(private readonly run: RunClaude = runClaude("claude")) {}

  async status(): Promise<ProviderStatus> {
    let version: string;
    try {
      version = (await this.run(["--version"], 15_000)).trim().replace(/\s*\(Claude Code\)$/, "");
    } catch {
      return {
        installed: false,
        signedIn: false,
        detail: "Claude Code was not found. Install it from claude.com/claude-code, then sign in.",
      };
    }
    let auth: { loggedIn?: boolean; subscriptionType?: string; authMethod?: string } = {};
    try {
      auth = JSON.parse(await this.run(["auth", "status"], 15_000)) as typeof auth;
    } catch {
      // Older versions: unknown until the first answer.
    }
    const plan = auth.subscriptionType
      ? `Claude ${auth.subscriptionType.charAt(0).toUpperCase()}${auth.subscriptionType.slice(1)}`
      : undefined;
    if (auth.loggedIn === false) {
      return { installed: true, signedIn: false, version, detail: this.signIn };
    }
    return {
      installed: true,
      signedIn: true,
      version,
      ...(plan === undefined ? {} : { plan }),
      detail: `Signed in${plan ? ` with ${plan}` : ""}: answers spend your Claude plan.`,
    };
  }

  models(): Promise<readonly ModelOption[]> {
    this.#models ??= Promise.all([
      this.#currentModel(undefined).then((name) => ({
        id: "default",
        name: name ?? "Default",
        hint: "Claude Code's own choice",
      })),
      ...FAMILIES.map(async (family) => ({
        id: family.id,
        name: (await this.#currentModel(family.id)) ?? capital(family.id),
        hint: family.hint,
      })),
    ]);
    return this.#models;
  }

  efforts(): readonly string[] {
    return CLAUDE_EFFORTS;
  }

  async usage(): Promise<ProviderUsage | undefined> {
    let text: string;
    try {
      text = resultOf(await this.run(headless("/usage"), 30_000));
    } catch {
      return undefined;
    }
    const limits = parseUsage(text);
    if (limits.length === 0) return undefined;
    const note = /subscription/i.test(text) ? "Your Claude subscription" : undefined;
    return { limits, at: new Date(), ...(note === undefined ? {} : { note }) };
  }

  modelName(id: string): string {
    return claudeModelName(id);
  }

  create(choice: ModelChoice) {
    return createModel("claude-code", {
      ...(choice.model === undefined ? {} : { claudeModel: choice.model }),
      ...(choice.effort === undefined ? {} : { claudeEffort: choice.effort }),
    });
  }

  /** The exact name Claude Code gives the model of an alias: "Opus 5.5". */
  async #currentModel(alias: string | undefined): Promise<string | undefined> {
    try {
      const args = [...headless("/model"), ...(alias === undefined ? [] : [`--model=${alias}`])];
      const text = resultOf(await this.run(args, 30_000));
      return /Current model:\s*`?([^`\n]+?)`?\s*$/m.exec(text)?.[1]?.trim();
    } catch {
      return undefined;
    }
  }
}

function headless(command: string): string[] {
  return ["-p", command, "--output-format=json", "--setting-sources=", "--no-session-persistence"];
}

/** Reads Claude Code's `/usage`: "Current session: 91% used · resets Nov 14, 1:19pm (…)". */
export function parseUsage(text: string): UsageLimit[] {
  const limits: UsageLimit[] = [];
  for (const match of text.matchAll(
    /^\s*Current ([^:\n]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n]+))?/gim,
  )) {
    const what = (match[1] ?? "").trim();
    limits.push({
      label: capital(what),
      used: Number(match[2]) / 100,
      ...(match[3] === undefined ? {} : { resets: match[3].trim() }),
    });
  }
  return limits;
}

/** `claude-opus-5-5` → "Opus 5.5"; `claude-sonnet-5-5[1m]` → "Sonnet 5.5 (1M)". */
export function claudeModelName(id: string): string {
  const wide = /\[1m\]$/i.test(id);
  const parts = id
    .replace(/\[1m\]$/i, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-");
  const family = parts
    .filter((p) => !/^\d+$/.test(p))
    .map(capital)
    .join(" ");
  const version = parts.filter((p) => /^\d+$/.test(p)).join(".");
  const name = [family, version].filter(Boolean).join(" ") || id;
  return wide ? `${name} (1M)` : name;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
