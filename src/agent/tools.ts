import type { JsonSchema, ToolCall, ToolHost, ToolOutcome, ToolSpec } from "../model/index.js";
import { validate } from "./validate.js";

/** What a tool sees when it runs. */
export interface ToolContext {
  readonly signal: AbortSignal;
}

/**
 * What may happen with one call:
 * - `free`: it runs;
 * - `ask`: it runs only if the user allows this call;
 * - `never`: it does not run, whatever anyone says.
 */
export type Permission = "free" | "ask" | "never";

export interface PermissionDecision {
  readonly permission: Permission;
  /** Why, in a few words: shown to the user when asked, and to the model when refused. */
  readonly reason?: string;
}

/** A tool of the agent: what the model is told, and what runs. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Whether it changes anything outside the agent's own memory. */
  readonly writes: boolean;
  /**
   * The permission for this call. Default: `ask` for a tool that writes,
   * `free` for one that only reads.
   */
  permission?(input: Record<string, unknown>): PermissionDecision;
  /** The call in a few lines, for the user deciding whether to allow it. */
  describe?(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, context: ToolContext): Promise<string> | string;
}

/**
 * Decides whether a call that needs permission may run. It is asked before
 * every such call; without one, those calls never run.
 */
export type Approver = (
  call: ToolCall,
  tool: Tool,
  decision: PermissionDecision,
) => Promise<boolean> | boolean;

export interface ToolRegistryOptions {
  /** Secrets that must never reach the model: replaced in every tool's output. */
  readonly redact?: readonly string[];
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The permission of a call, by the tool's own rule or its kind. */
export function permissionOf(tool: Tool, input: Record<string, unknown>): PermissionDecision {
  return tool.permission?.(input) ?? { permission: tool.writes ? "ask" : "free" };
}

/**
 * The agent's tools, as the model's `ToolHost`: it checks each call's
 * arguments and permission, asks the user when the call needs it, keeps
 * the agent's secrets out of what tools return, and turns a tool's failure
 * into an error the model reads, never a crash of the turn.
 */
export class ToolRegistry implements ToolHost {
  readonly #tools = new Map<string, Tool>();
  readonly #redact: readonly string[];

  constructor(
    tools: readonly Tool[] = [],
    private readonly approve?: Approver,
    options: ToolRegistryOptions = {},
  ) {
    this.#redact = (options.redact ?? []).filter((secret) => secret.length >= 8);
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool): this {
    if (!NAME.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (tool.inputSchema.type !== "object") {
      throw new Error(`Tool ${tool.name}: its input schema must be an object`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  get tools(): ToolSpec[] {
    return [...this.#tools.values()].map(({ name, description, inputSchema, writes }) => ({
      name,
      description,
      inputSchema,
      writes,
    }));
  }

  async call(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const tool = this.#tools.get(call.name);
    if (!tool) return { content: `There is no tool named ${call.name}.`, isError: true };

    const problems = validate(call.input, tool.inputSchema);
    if (problems.length > 0) {
      return { content: `Invalid arguments: ${problems.join("; ")}.`, isError: true };
    }

    const decision = permissionOf(tool, call.input);
    if (decision.permission === "never") {
      return {
        content: `Not allowed: ${decision.reason ?? `${call.name} may not do this`}. Do not try another way around it.`,
        isError: true,
      };
    }
    if (decision.permission === "ask") {
      const allowed = this.approve ? await this.approve(call, tool, decision) : false;
      if (!allowed) {
        return {
          content: `The user did not allow ${call.name} to run. Do not try it again unless they ask.`,
          isError: true,
        };
      }
    }

    if (signal.aborted) return { content: "The turn was cancelled.", isError: true };
    try {
      return { content: this.#clean(await tool.run(call.input, { signal })) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: this.#clean(`${call.name} failed: ${message}`), isError: true };
    }
  }

  #clean(text: string): string {
    let clean = text;
    for (const secret of this.#redact) clean = clean.split(secret).join("[secret removed]");
    return clean;
  }
}
