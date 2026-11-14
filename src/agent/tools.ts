import type { JsonSchema, ToolCall, ToolHost, ToolOutcome, ToolSpec } from "../model/index.js";
import { validate } from "./validate.js";

/** What a tool sees when it runs. */
export interface ToolContext {
  readonly signal: AbortSignal;
}

/** A tool of the agent: what the model is told, and what runs. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Whether it changes anything outside the agent's own memory: then it asks first. */
  readonly writes: boolean;
  run(input: Record<string, unknown>, context: ToolContext): Promise<string> | string;
}

/**
 * Decides whether a writing tool may run this call. It is asked before
 * every call of a tool that writes; without one, writing tools never run.
 */
export type Approver = (call: ToolCall, tool: Tool) => Promise<boolean> | boolean;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The agent's tools, as the model's `ToolHost`: it checks each call's
 * arguments, asks before any tool that writes, and turns a tool's failure
 * into an error the model reads, never a crash of the turn.
 */
export class ToolRegistry implements ToolHost {
  readonly #tools = new Map<string, Tool>();

  constructor(
    tools: readonly Tool[] = [],
    private readonly approve?: Approver,
  ) {
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

    if (tool.writes) {
      const allowed = this.approve ? await this.approve(call, tool) : false;
      if (!allowed) {
        return {
          content: `The user did not allow ${call.name} to run. Do not try it again unless they ask.`,
          isError: true,
        };
      }
    }

    if (signal.aborted) return { content: "The turn was cancelled.", isError: true };
    try {
      return { content: await tool.run(call.input, { signal }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `${call.name} failed: ${message}`, isError: true };
    }
  }
}
