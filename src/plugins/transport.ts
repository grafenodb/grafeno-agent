import { spawn } from "node:child_process";
import type { ApiResponse, ApiTransport } from "./types.js";

const TIMEOUT_MS = 30_000;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The output of `gh api --include` / `glab api --include`: the status line
 * and headers, a blank line, then the body.
 */
export function parseIncluded(output: string): ApiResponse {
  const match = /^HTTP\/[\d.]+\s+(\d{3})[^\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/.exec(output);
  if (!match) return { status: 0, data: parse(output), text: output };
  const text = output.slice(match[0].length);
  return { status: Number(match[1]), data: parse(text), text };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with arguments (never through a shell), giving it `input` on stdin. */
export function runProgram(
  program: string,
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * The service's API through its official CLI (`gh api`, `glab api`): the
 * CLI signs the request with its own sign-in, which the agent never reads.
 */
export function cliTransport(
  program: string,
  options: { readonly hostname?: string; readonly run?: typeof runProgram } = {},
): ApiTransport {
  const run = options.run ?? runProgram;
  return {
    async request(method, path, body, signal) {
      const args = [
        "api",
        "--method",
        method,
        "--include",
        ...(options.hostname ? ["--hostname", options.hostname] : []),
        ...(body === undefined ? [] : ["--input", "-"]),
        path.replace(/^\//, ""),
      ];
      const result = await run(
        program,
        args,
        body === undefined ? undefined : JSON.stringify(body),
        signal,
      );
      const response = parseIncluded(result.stdout);
      if (response.status === 0) {
        const why = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? "";
        throw new Error(`${program} api failed${why ? `: ${why}` : ""}`);
      }
      return response;
    },
  };
}

/** The service's API over HTTPS with a token the user made for it. */
export function tokenTransport(
  base: string,
  headers: Readonly<Record<string, string>>,
  doFetch: typeof fetch = fetch,
): ApiTransport {
  return {
    async request(method, path, body, signal) {
      const response = await doFetch(`${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
        method,
        headers: {
          ...headers,
          "user-agent": "grafeno-agent",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      return { status: response.status, data: parse(text), text };
    },
  };
}

/** The response's data, or an error that says what the service answered. */
export function ok(response: ApiResponse, what: string): unknown {
  if (response.status >= 200 && response.status < 300) return response.data;
  const message =
    (response.data as { message?: unknown; error?: unknown } | undefined)?.message ??
    (response.data as { error?: unknown } | undefined)?.error ??
    response.text.slice(0, 300);
  const hint =
    response.status === 401
      ? " (the sign-in is not valid: sign in again)"
      : response.status === 403
        ? " (not allowed for this account, or a rate limit)"
        : response.status === 404
          ? " (not found, or this account cannot see it)"
          : "";
  throw new Error(`${what}: ${String(response.status)} ${JSON.stringify(message)}${hint}`);
}
