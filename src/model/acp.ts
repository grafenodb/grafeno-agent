import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Channel } from "./channel.js";
import { childEnv } from "./env.js";
import { ModelError } from "./errors.js";
import { serveTools, type McpToolServer } from "./mcp-host.js";
import { abortReason } from "./turn.js";
import type {
  Conversation,
  ConversationOptions,
  Model,
  ModelEvent,
  SendOptions,
  StopReason,
  ToolOutcome,
} from "./types.js";

/** The agent's MCP server, as the CLI sees it in its session. */
export const ACP_SERVER = "grafeno";

/** How to start a CLI's ACP server: its program, arguments and the sign-in variables it may keep. */
export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Run through the shell (a Windows .cmd shim): only with fixed arguments. */
  readonly shell?: boolean;
  /** Variables of its own documented sign-in that it may see (GH_TOKEN for Copilot…). */
  readonly keep?: readonly string[];
}

export interface AcpModelOptions {
  /** The connection's name, for messages: "GitHub Copilot". */
  readonly name: string;
  readonly launch: () => AcpLaunch;
  /** What to tell a person who is not signed in. */
  readonly signIn: string;
  readonly spawn?: typeof nodeSpawn;
  /** Time to start the server and open a session. Default: 60 seconds. */
  readonly startTimeoutMs?: number;
}

/** A permission request, as the client decides it. */
export interface PermissionAsk {
  readonly toolCall?: {
    readonly title?: string | null;
    readonly name?: string | null;
    readonly kind?: string | null;
  };
  readonly options: readonly { readonly optionId: string; readonly kind: string }[];
}

/**
 * The answer to a CLI's permission request. The agent's own tools (its MCP
 * server's) may run: the agent's approvals decide each call when it
 * arrives. The CLI's built-in tools are refused, so it reads, writes and
 * runs only through the agent.
 */
export function permissionAnswer(
  ask: PermissionAsk,
  agentTools: readonly string[],
): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } {
  const text = `${ask.toolCall?.name ?? ""} ${ask.toolCall?.title ?? ""}`.toLowerCase();
  const ours =
    text.includes(ACP_SERVER) &&
    agentTools.some((tool) =>
      new RegExp(`(^|[^a-z0-9_])${tool.toLowerCase()}([^a-z0-9_]|$)`).test(text),
    );
  const pick = (kinds: readonly string[]) => ask.options.find((o) => kinds.includes(o.kind));
  const chosen = ours ? pick(["allow_once"]) : pick(["reject_once", "reject_always"]);
  return chosen
    ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/**
 * A model behind a CLI's ACP server (Agent Client Protocol, the documented
 * way for editors and scripts to drive Copilot CLI, Qwen Code, Kimi Code
 * and Mistral Vibe): the CLI runs as the brain, signed in its own way; the
 * agent's tools reach it over MCP.
 */
export class AcpModel implements Model {
  readonly name: string;

  constructor(private readonly options: AcpModelOptions) {
    this.name = options.name;
  }

  async open(options: ConversationOptions): Promise<Conversation> {
    const conversation = new AcpConversation(this.options, options);
    try {
      await conversation.start();
    } catch (error) {
      await conversation.close();
      throw error;
    }
    return conversation;
  }
}

interface Turn {
  readonly channel: Channel<ModelEvent>;
  readonly signal: AbortSignal;
  steps: number;
  stepLimitHit: boolean;
}

class AcpConversation implements Conversation {
  #child: ChildProcess | undefined;
  #tools: McpToolServer | undefined;
  #dir: string | undefined;
  #connection: acp.ClientConnection | undefined;
  #session: acp.ActiveSession | undefined;
  #turn: Turn | undefined;
  #calls = 0;
  #stderr = "";

  constructor(
    private readonly options: AcpModelOptions,
    private readonly conversation: ConversationOptions,
  ) {}

  async start(): Promise<void> {
    this.#tools = await serveTools(this.conversation.tools.tools, (name, input) =>
      this.#runTool(name, input),
    );
    // A private, empty working folder: nothing of the user's for the CLI's own tools.
    this.#dir = await mkdtemp(join(tmpdir(), "grafeno-agent-acp-"));
    const launch = this.options.launch();
    const keep = Object.fromEntries(
      (launch.keep ?? []).flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const child = (this.options.spawn ?? nodeSpawn)(launch.command, [...launch.args], {
      cwd: this.#dir,
      env: childEnv(process.env, keep),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(launch.shell ? { shell: true } : {}),
    });
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    const exited = new Promise<never>((_, reject) => {
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          new ModelError(
            "setup",
            error.code === "ENOENT"
              ? `${this.options.name} was not found. ${this.options.signIn}`
              : `${this.options.name} could not start: ${error.message}`,
          ),
        );
      });
      child.on("exit", (code) => {
        reject(
          new ModelError(
            "lost",
            `${this.options.name} ended (code ${String(code)})${this.#stderr ? `: ${this.#stderr.trim().slice(-500)}` : ""}`,
          ),
        );
      });
    });
    exited.catch(() => undefined);
    const agentTools = this.conversation.tools.tools.map((t) => t.name);
    const app = acp
      .client({ name: "grafeno-agent" })
      .onRequest("session/request_permission", ({ params }) =>
        permissionAnswer(params as unknown as PermissionAsk, agentTools),
      );
    const connection = app.connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    this.#connection = connection;
    const tools = this.#tools;
    const opening = (async () => {
      const init = await connection.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        // No file system or terminal of the client: the CLI works only through the agent's tools.
        clientCapabilities: {},
      });
      if (init.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw new ModelError(
          "setup",
          `${this.options.name}'s ACP server does not take an HTTP MCP server, so the agent's tools cannot reach it.`,
        );
      }
      return connection.agent
        .buildSession({
          cwd: this.#dir ?? tmpdir(),
          mcpServers: [
            {
              type: "http",
              name: ACP_SERVER,
              url: tools.url,
              headers: Object.entries(tools.headers).map(([name, value]) => ({ name, value })),
            },
          ],
        })
        .start();
    })();
    try {
      this.#session = await Promise.race([
        opening,
        exited,
        timeout(
          this.options.startTimeoutMs ?? 60_000,
          `${this.options.name} did not open a session in time`,
        ),
      ]);
    } catch (error) {
      throw acpError(error, this.options);
    }
  }

  send(message: string, options: SendOptions = {}): AsyncIterable<ModelEvent> {
    const session = this.#session;
    if (!session) throw new ModelError("lost", "The conversation is not started");
    if (this.#turn) throw new ModelError("failed", "A turn is already running");
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortReason(signal);
    const turn: Turn = {
      channel: new Channel<ModelEvent>(),
      signal,
      steps: 1,
      stepLimitHit: false,
    };
    this.#turn = turn;
    const onAbort = () => {
      // The CLI is told to stop; the turn ends at once, the session stays.
      void this.#connection?.agent.notify("session/cancel", { sessionId: session.sessionId });
      turn.channel.fail(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void this.#run(turn, session, message).then(
      () => {
        turn.channel.end();
      },
      (error: unknown) => {
        turn.channel.fail(signal.aborted ? abortReason(signal) : acpError(error, this.options));
      },
    );
    const channel = turn.channel;
    const done = () => {
      signal.removeEventListener("abort", onAbort);
      if (this.#turn === turn) this.#turn = undefined;
    };
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = channel[Symbol.asyncIterator]();
        return {
          next: async () => {
            try {
              const next = await iterator.next();
              if (next.done) done();
              return next;
            } catch (error) {
              done();
              throw error;
            }
          },
        };
      },
    };
  }

  async #run(turn: Turn, session: acp.ActiveSession, message: string): Promise<void> {
    const prompt = session.prompt(message);
    prompt.catch(() => undefined);
    let text = "";
    for (;;) {
      const next = await session.nextUpdate();
      if (next.kind === "stop") {
        if (next.stopReason === "cancelled")
          throw new ModelError("cancelled", "The turn was cancelled");
        turn.channel.push({
          type: "done",
          result: {
            text,
            stopReason: turn.stepLimitHit ? "max_steps" : stopReason(next.stopReason),
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            steps: turn.steps,
          },
        });
        return;
      }
      const update = next.update as {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        used?: number;
        size?: number;
      };
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        const piece = update.content.text ?? "";
        if (piece !== "") {
          text += piece;
          turn.channel.push({ type: "text", text: piece });
        }
      } else if (update.sessionUpdate === "usage_update" && typeof update.used === "number") {
        turn.channel.push({
          type: "context",
          used: update.used,
          ...(typeof update.size === "number" ? { window: update.size } : {}),
        });
      }
    }
  }

  async #runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const turn = this.#turn;
    if (!turn) return { content: "No turn is running.", isError: true };
    if (turn.steps >= (this.conversation.maxSteps ?? Infinity)) {
      turn.stepLimitHit = true;
      return {
        content: "This turn has reached its step limit. Answer now with what you have.",
        isError: true,
      };
    }
    turn.steps++;
    const call = { id: `call-${String(++this.#calls)}`, name, input };
    turn.channel.push({ type: "tool_call", call });
    let outcome: ToolOutcome;
    try {
      outcome = await this.conversation.tools.call(call, turn.signal);
    } catch (error) {
      outcome = {
        content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    turn.channel.push({ type: "tool_result", callId: call.id, outcome });
    return outcome;
  }

  async close(): Promise<void> {
    this.#session?.dispose();
    this.#connection?.close();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.stdin?.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      clearTimeout(timer);
    }
    await this.#tools?.close();
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function stopReason(reason: string): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "max_turn_requests":
      return "max_steps";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** An ACP failure as the agent's kinds: -32000 is "not signed in". */
export function acpError(
  error: unknown,
  options: Pick<AcpModelOptions, "name" | "signIn">,
): ModelError {
  if (error instanceof ModelError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === -32000 || /auth/i.test(message)) {
    return new ModelError("setup", `${options.name} is not signed in. ${options.signIn}`);
  }
  if (/quota|rate limit|429|limit reached|exceeded/i.test(message)) {
    return new ModelError("usage_limit", `${options.name}: ${message}`, {
      resetsAt: new Date(Date.now() + 60_000),
    });
  }
  return new ModelError("failed", `${options.name}: ${message}`);
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new ModelError("unavailable", message));
    }, ms).unref();
  });
}
