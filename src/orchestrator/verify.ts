import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { commandPermission, defaultShell, killTree } from "../tools/command.js";
import type { Workspace } from "../tools/workspace.js";
import type { Acceptance } from "./plan.js";
import type { Verify } from "./pipeline.js";

/** What a command printed and how it ended. */
export interface CommandResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * Runs a check's command in a folder. The default runs it in the shell
 * with the user's rights (the worktree is the only bound): it is not a
 * sandbox. A container runner can take its place (decision D2).
 */
export interface CommandRunner {
  run(
    command: string,
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

export interface ShellRunnerOptions {
  readonly shell?: readonly [string, ...string[]];
  /** Environment variables commands must not see (the agent's secrets). */
  readonly hiddenEnv?: readonly string[];
}

/** Runs commands in the user's shell, stopping the whole process tree on timeout or abort. */
export function shellRunner(options: ShellRunnerOptions = {}): CommandRunner {
  const [shell, ...shellArgs] = options.shell ?? defaultShell();
  const hidden = new Set(options.hiddenEnv ?? []);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !hidden.has(name)));
  return {
    run: (command, { cwd, timeoutMs, signal }) =>
      new Promise((resolve, reject) => {
        const child = spawn(shell, [...shellArgs, command], {
          cwd,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        let output = "";
        let timedOut = false;
        let finished = false;
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-200_000);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs);
        const onAbort = () => {
          killTree(child);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ code, output, timedOut });
        };
        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", finish);
        child.on("exit", (code) => {
          setTimeout(() => {
            finish(code);
          }, 1_000).unref();
        });
      }),
  };
}

/** One acceptance check, as it turned out. */
export interface CheckResult {
  readonly check: Acceptance;
  readonly passed: boolean;
  /** Not checked by code (a review): it neither passes nor fails a task alone. */
  readonly skipped?: boolean;
  readonly detail: string;
}

export interface VerifierOptions {
  readonly runner?: CommandRunner;
  /** Time one check may take. Default: 10 minutes. */
  readonly timeoutMs?: number;
  /** Characters of a failing check's output given back to the worker. Default: 3000. */
  readonly maxDiagnostic?: number;
  /** Secrets replaced in what is given back. */
  readonly redact?: readonly string[];
}

/**
 * Checks a task's acceptance by code, in its workspace: each command must
 * exit 0 (and the policy must allow it), each file must exist inside the
 * workspace. A review is not checked here: it is extra evidence, never the
 * only one. Whatever the model said, a task passes only when its checks do.
 */
export async function verify(
  acceptance: readonly Acceptance[],
  workspace: Workspace,
  options: VerifierOptions = {},
): Promise<{ ok: boolean; results: CheckResult[]; diagnostic: string }> {
  const runner = options.runner ?? shellRunner();
  const results: CheckResult[] = [];
  for (const check of acceptance) {
    if (check.check === "review") {
      results.push({
        check,
        passed: true,
        skipped: true,
        detail: "a review is not checked by code",
      });
      continue;
    }
    if (check.check === "files") {
      const missing: string[] = [];
      for (const path of check.exist) {
        const inside = workspace.check(path);
        if ("refused" in inside || !existsSync(inside.absolute)) missing.push(path);
      }
      results.push({
        check,
        passed: missing.length === 0,
        detail: missing.length === 0 ? "all files exist" : `missing: ${missing.join(", ")}`,
      });
      continue;
    }
    const permission = commandPermission(check.run);
    if (permission.permission === "never") {
      results.push({
        check,
        passed: false,
        detail: `the command is never allowed: ${permission.reason ?? ""}`,
      });
      continue;
    }
    const result = await runner.run(check.run, {
      cwd: workspace.root,
      timeoutMs: options.timeoutMs ?? 600_000,
    });
    const passed = result.code === 0 && !result.timedOut;
    results.push({
      check,
      passed,
      detail: result.timedOut
        ? `\`${check.run}\` took too long and was stopped`
        : `\`${check.run}\` exited ${String(result.code)}${passed ? "" : `:\n${tail(clean(result.output, options.redact), options.maxDiagnostic ?? 3000)}`}`,
    });
  }
  const failed = results.filter((r) => !r.passed);
  const diagnostic =
    failed.length === 0
      ? ""
      : `These checks failed; fix the work so that they pass:\n${failed.map((r) => `- ${r.detail}`).join("\n")}`;
  return { ok: failed.length === 0, results, diagnostic };
}

/** The verifier as the pipeline's hook: the task's own acceptance, in its worktree. */
export function verifier(options: VerifierOptions = {}): Verify {
  return async (task, workspace) => {
    const checked = await verify(task.spec.acceptance, workspace, options);
    return checked.ok ? { ok: true } : { ok: false, diagnostic: checked.diagnostic };
  };
}

function tail(text: string, max: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

function clean(text: string, redact: readonly string[] = []): string {
  let out = text;
  for (const secret of redact) if (secret) out = out.split(secret).join("[secret]");
  return out;
}
