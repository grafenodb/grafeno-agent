import type { Config } from "../config.js";
import { detectProject } from "../memory/project.js";
import { compactResume, type CompactResume } from "../memory/resume.js";
import { findProject } from "../memory/session.js";
import { grafenoVault, type Vault } from "../memory/vault.js";

export interface CompactResumeRequest {
  /** The folder whose project to resume; default: the current one. */
  readonly cwd?: string;
  /** The project's name, when not the folder's (or AGENT_PROJECT). */
  readonly project?: string;
  /** Resume a task by its name instead of the project's latest checkpoint. */
  readonly task?: string;
  /** This agent's own checkpoint first. */
  readonly agent?: string;
  readonly checkpointBudget?: number;
  readonly memoryBudget?: number;
  readonly maxMemories?: number;
  /** Look memories up by this instead of the task's goal and next action (level 2). */
  readonly query?: string;
}

/**
 * `grafeno-agent resume --compact`: the compact state of the project's work,
 * read from Grafeno by code, for a new session to start from. It only reads:
 * nothing is created in memory, and no model is called. A `SessionStart`
 * hook of Claude Code prints it, so a session started directly with Claude
 * Code begins with it too.
 */
export async function resumeCompact(
  config: Config,
  request: CompactResumeRequest,
  vault: Vault = grafenoVault(config),
): Promise<CompactResume> {
  const started = Date.now();
  const limits = config.memoryLimits ?? {};
  const budgets = {
    ...(limits.checkpoint === undefined ? {} : { checkpointBudget: limits.checkpoint }),
    ...(limits.memories === undefined ? {} : { memoryBudget: limits.memories }),
    ...(limits.maxMemories === undefined ? {} : { maxMemories: limits.maxMemories }),
    ...(request.query === undefined ? {} : { query: request.query }),
    ...(request.checkpointBudget === undefined
      ? {}
      : { checkpointBudget: request.checkpointBudget }),
    ...(request.memoryBudget === undefined ? {} : { memoryBudget: request.memoryBudget }),
    ...(request.maxMemories === undefined ? {} : { maxMemories: request.maxMemories }),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  };
  if (request.task !== undefined) return compactResume({ vault, task: request.task, ...budgets });
  const project = detectProject(request.cwd ?? process.cwd(), request.project ?? config.project);
  let about: string | undefined;
  try {
    about = await findProject(vault, project);
  } catch (error) {
    return compactResume({
      vault: {
        ...vault,
        call: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
      },
      ...budgets,
    });
  }
  const resumed = await compactResume({
    vault,
    ...(about === undefined ? {} : { about }),
    ...budgets,
  });
  // The project lookup is one more call to Grafeno.
  return {
    ...resumed,
    stats: { ...resumed.stats, calls: resumed.stats.calls + 1, durationMs: Date.now() - started },
  };
}

/** One line of measures, for a person or a log (never for the model's context). */
export function describeResumeStats(resumed: CompactResume): string {
  const s = resumed.stats;
  return `compact resume: ${String(s.totalTokens)} tokens (est.; checkpoint ${String(s.checkpointTokens)}, memories ${String(s.memoryTokens)}), ${String(s.itemsReturned)} memories, ${String(s.itemsLeftOut)} listed by id, ${String(s.itemsDeduplicated)} repeats left out, ${String(s.calls)} Grafeno calls, ${String(s.durationMs)} ms`;
}
