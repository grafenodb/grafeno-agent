import type { PermissionDecision, Tool } from "./tools.js";
import { CHECK_COMMANDS, SENSITIVE_COMMANDS } from "../orchestrator/policy.js";

/**
 * How calls that would ask the user are decided:
 * - `ask`: the user is asked (the default);
 * - `auto`: the agent decides by the call's risk, in code: what stays in
 *   the project and can be undone runs, what reaches outside it, deletes,
 *   publishes or installs is asked;
 * - `skip`: nothing is asked: every such call runs.
 *
 * In every mode, what a tool forbids (`never`: leaving the project,
 * secrets, raised privileges, forced pushes, deleting everything, code
 * piped from the internet) stays forbidden.
 */
export const PERMISSION_MODES = ["ask", "auto", "skip"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Where a permission mode applies. */
export const PERMISSION_SCOPES = ["agent", "session", "session+subagents"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** The setting that keeps the agent-wide mode. */
export const PERMISSIONS_SETTING = "AGENT_PERMISSIONS";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The agent-wide mode in the settings; `ask` when unset or unknown. */
export function settingsPermissionMode(
  env: Record<string, string | undefined> = process.env,
): PermissionMode {
  const value = env[PERMISSIONS_SETTING]?.trim().toLowerCase();
  return isPermissionMode(value) ? value : "ask";
}

/** How a mode is named to a person. */
export const PERMISSION_LABELS: Readonly<Record<PermissionMode, string>> = {
  ask: "Ask",
  auto: "Automatic",
  skip: "Skip permissions",
};

/** Shell characters that let one command become several. */
const COMPOUND = /[;&|<>`]|\$\(|\r|\n/;

/** Commands that install programs on the computer, beyond the project. */
const INSTALLS =
  /\b(winget|choco|scoop|brew|apt(-get)?|dnf|yum|pacman|snap)\s+(install|upgrade|add)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-g|--global)\b|\bpip3?\s+install\b(?!.*(-r|--requirement)\s)|\bcargo\s+install\b|\bgo\s+install\b/i;

/** Other commands that stay in the project and can be undone with git. */
const SAFE_COMMANDS: readonly RegExp[] = [
  /^git\s+(status|diff|log|show|add|commit|switch|checkout\s+-b|branch|stash|restore\s+--staged|fetch|pull)\b(?!.*--amend)/,
  /^(mkdir|touch)(\s+(-p\s+)?[\w./-]+)+$/,
  /^(cp|mv)(\s+-[a-z]+)*(\s+[\w./-]+){2,}$/,
  /^(ls|dir|pwd|cat|head|tail|wc|echo)\b/,
];

/** Tools whose changes stay in the project's files. */
const PROJECT_WRITES = new Set(["write_file", "edit_file", "multi_edit", "move_file"]);

/**
 * In `auto`, whether a call the user would be asked about runs without
 * asking, and why. The tool's own decision already refused what is never
 * allowed and checked the paths.
 */
export function autoAllows(
  tool: Pick<Tool, "name">,
  input: Record<string, unknown>,
): { allow: boolean; reason: string } {
  if (PROJECT_WRITES.has(tool.name)) {
    return { allow: true, reason: "a change to the project's files, which git can undo" };
  }
  if (tool.name === "delete_file") return { allow: false, reason: "it deletes a file" };
  if (tool.name === "local_http") return { allow: true, reason: "a server on this computer" };
  if (tool.name === "web_fetch") return { allow: true, reason: "it only reads a public page" };
  if (tool.name === "run_command" || tool.name === "start_process") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const sensitive = SENSITIVE_COMMANDS.find((rule) => rule.pattern.test(command));
    if (sensitive) return { allow: false, reason: sensitive.reason };
    if (INSTALLS.test(command)) return { allow: false, reason: "it installs a program" };
    if (COMPOUND.test(command)) return { allow: false, reason: "several commands in one" };
    if ([...CHECK_COMMANDS, ...SAFE_COMMANDS].some((pattern) => pattern.test(command))) {
      return { allow: true, reason: "a check, a build or a change git can undo" };
    }
    return { allow: false, reason: "a command it cannot tell is safe" };
  }
  // Plugins, external MCP servers and anything else: it reaches outside.
  return { allow: false, reason: "it acts outside the project" };
}

/**
 * Whether a call runs at once, asks the user, or never runs, by the mode
 * and the tool's own decision.
 */
export function decide(
  mode: PermissionMode,
  tool: Pick<Tool, "name">,
  input: Record<string, unknown>,
  own: PermissionDecision,
): { verdict: "allow" | "ask" | "never"; reason: string } {
  if (own.permission === "never") return { verdict: "never", reason: own.reason ?? "forbidden" };
  if (own.permission === "free") return { verdict: "allow", reason: own.reason ?? "it only reads" };
  if (mode === "skip") return { verdict: "allow", reason: "permissions are skipped" };
  if (mode === "auto") {
    const auto = autoAllows(tool, input);
    return auto.allow
      ? { verdict: "allow", reason: `automatic: ${auto.reason}` }
      : { verdict: "ask", reason: `automatic asks: ${auto.reason}` };
  }
  return { verdict: "ask", reason: own.reason ?? "it needs permission" };
}
