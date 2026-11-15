import type { Tool } from "../agent/tools.js";

/**
 * Runs a request as sub-agents: plans it, asks the person to run the plan,
 * runs it and says how it ended (the run's report), for the main agent.
 */
export type LaunchSubAgents = (request: string, signal: AbortSignal) => Promise<string>;

export const DELEGATE_TOOL = "delegate";

/**
 * The main agent's way to start sub-agents, on any provider: a request
 * large enough for several tasks becomes a plan, checked as a graph of
 * tasks, which runs in parallel, each task in its own git worktree with its
 * own checks, once the person says so. The sub-agents take no prompts: the
 * main agent orchestrates them, and reads their report when they are done.
 */
export function delegateTool(launch: LaunchSubAgents): Tool {
  return {
    name: DELEGATE_TOOL,
    description: [
      "Hand a large piece of work to sub-agents that work in parallel, each in its own git worktree, checked by commands before their work is merged into the run's branch.",
      "Use it when the work has several parts that can go on at once (for example backend, frontend, tests and docs), or is too large for one conversation. Do not use it for a question, an explanation or a small change: do those yourself.",
      "Give the whole request in detail: what to build, where, and how to check it. A planner splits it into tasks; the person sees the plan and decides whether to run it.",
      "It returns the run's report: each task's outcome and the branch holding the work.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "The work, in detail: goal, the parts, files or areas, and how to check it.",
        },
      },
      required: ["request"],
    },
    writes: true,
    // The person approves the plan itself (or not) before anything runs.
    permission: () => ({ permission: "free", reason: "the plan is shown to the person first" }),
    describe: (input) =>
      `Sub-agents: ${(typeof input.request === "string" ? input.request : "").split("\n", 1)[0] ?? ""}`,
    async run(input, context) {
      const request = typeof input.request === "string" ? input.request.trim() : "";
      if (request === "") return "No request was given: say what the sub-agents should do.";
      return launch(request, context.signal);
    },
  };
}
