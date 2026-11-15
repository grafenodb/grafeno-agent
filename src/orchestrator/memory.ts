import type { Embedder } from "../embed/types.js";
import { MemorySession, type Project } from "../memory/session.js";
import type { Vault } from "../memory/vault.js";
import type { AttemptContext } from "./scheduler.js";
import type { TaskRecord } from "./store.js";
import type { WorkerMemory } from "./workers.js";

export interface RunMemoryOptions {
  readonly vault: Vault;
  readonly project: Project;
  readonly palace?: "shared" | "own";
  /** Secrets never to be stored (the agent's key). */
  readonly knownSecrets?: readonly string[];
  readonly embedder?: Embedder;
  /** Tokens of memory related to a task, given at its start. Default: 500. */
  readonly taskBudget?: number;
  /** Memories inherited from dependencies, at most. Default: 12. */
  readonly maxInherited?: number;
}

/**
 * Each worker's memory in Grafeno, for a run: the project's shared palace,
 * the memory tools with their guards (secrets, duplicates, anchoring), what
 * the worker stores marked with its name as author, and, at the start,
 * only what its task needs: the memories its dependencies stored (by id:
 * decisions, contracts) and what memory holds about the task, within a
 * budget. When it is done, a checkpoint of the task.
 *
 * This is cognitive memory only: tasks, states and attempts live in the
 * operational store, never here.
 */
export function workerMemory(
  options: RunMemoryOptions,
): (task: TaskRecord, worker: string, context: AttemptContext) => Promise<WorkerMemory> {
  return async (task, worker, context) => {
    const session = await MemorySession.start({
      vault: options.vault,
      project: options.project,
      author: worker,
      brief: false,
      register: false,
      contextBudget: options.taskBudget ?? 500,
      ...(options.palace ? { palace: options.palace } : {}),
      ...(options.knownSecrets ? { knownSecrets: options.knownSecrets } : {}),
      ...(options.embedder ? { embedder: options.embedder } : {}),
    });
    const inherited = await inheritedMemories(options.vault, context, options.maxInherited ?? 12);
    const related = await relatedMemory(session, task);
    const brief = [
      inherited.length > 0 ? `### Stored by the tasks you build on\n${inherited.join("\n")}` : "",
      related ? `### Related memory\n${related}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      tools: await session.tools(),
      ...(brief ? { brief } : {}),
      stored: () => session.stored,
      progress: async (summary) => {
        const answer = await options.vault.call("checkpoint", {
          task: `${context.runId}: ${task.id}`,
          about: session.projectId,
          agent: worker,
          summary: `In progress (the session was renewed): ${summary.slice(0, 1400)}`,
          files: [...task.spec.touches],
        });
        if (answer.isError) throw new Error(answer.text);
      },
      finish: async (summary) => {
        const answer = await options.vault.call("checkpoint", {
          task: `${context.runId}: ${task.id}`,
          about: session.projectId,
          agent: worker,
          summary: summary.slice(0, 1500),
          done: [task.spec.title],
          files: [...task.spec.touches],
        });
        if (answer.isError) throw new Error(answer.text);
      },
    };
  };
}

/** The memories the task's dependencies stored, read by id: one line each, with who stored it. */
async function inheritedMemories(
  vault: Vault,
  context: AttemptContext,
  most: number,
): Promise<string[]> {
  const ids = [...new Set(context.inputs.flatMap((input) => input.memories ?? []))].slice(0, most);
  const lines: string[] = [];
  for (const id of ids) {
    const node = await vault.call("get_node", { id });
    if (node.isError) continue;
    const data = (node.data ?? safeJson(node.text)) as
      { text?: string; labels?: string[]; props?: { author?: string } } | undefined;
    if (!data?.text) continue;
    const kind = data.labels?.find((l) => l !== "Memory") ?? "Memory";
    const by = data.props?.author ? ` (by ${data.props.author})` : "";
    const text = data.text.length > 400 ? `${data.text.slice(0, 399)}…` : data.text;
    lines.push(`- [${id}] ${kind}${by}: ${text}`);
  }
  return lines;
}

/** What memory holds about the task, within the session's budget, without the wrapper. */
async function relatedMemory(
  session: MemorySession,
  task: TaskRecord,
): Promise<string | undefined> {
  const asked = `${task.spec.title}. ${task.spec.description}`;
  const prepared = await session.beforeTurn(asked);
  const match = /^<memory>\n([\s\S]*?)\n<\/memory>/.exec(prepared);
  return match?.[1]?.trim() || undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
