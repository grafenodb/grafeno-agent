import type { ToolCall, ToolHost, ToolOutcome, ToolSpec } from "../../src/model/index.js";

/** A tool host for tests: fixed handlers, and a record of every call. */
export class RecordingToolHost implements ToolHost {
  readonly calls: ToolCall[] = [];

  constructor(
    private readonly handlers: Record<
      string,
      {
        spec: Omit<ToolSpec, "name">;
        run: (input: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>;
      }
    > = {},
  ) {}

  get tools(): ToolSpec[] {
    return Object.entries(this.handlers).map(([name, { spec }]) => ({ name, ...spec }));
  }

  async call(call: ToolCall): Promise<ToolOutcome> {
    this.calls.push(call);
    const handler = this.handlers[call.name];
    if (!handler) return { content: `No such tool: ${call.name}`, isError: true };
    return handler.run(call.input);
  }
}

export const NO_TOOLS = new RecordingToolHost();
