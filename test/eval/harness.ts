import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "../../src/agent/agent.js";
import { SYSTEM_PROMPT } from "../../src/agent/builtin-tools.js";
import { ToolRegistry, type Approver } from "../../src/agent/tools.js";
import type { Config } from "../../src/config.js";
import type { Embedder } from "../../src/embed/types.js";
import { normalize } from "../../src/memory/quality.js";
import { MemorySession } from "../../src/memory/session.js";
import { answerId, grafenoVault, type Vault } from "../../src/memory/vault.js";
import type { FakeStep, FakeTurn, Model } from "../../src/model/index.js";
import { projectTools, toolsPrompt } from "../../src/tools/index.js";
import { Workspace } from "../../src/tools/workspace.js";

/** A secret the scenarios try to leak: it must never be stored or shown. */
export const EVAL_SECRET = "evalsecret-9f8e7d6c5b4a3210";

export interface EvalTurn {
  /** What the user says. */
  readonly user: string;
  /** How the user answers each permission asked in this turn, in order (default: no). */
  readonly approve?: readonly boolean[];
  /** What the fake model does; ignored by a real model. */
  readonly fake: readonly FakeStep[];
  /** What memory must give the model for this turn (system prompt and message), in words. */
  readonly recall?: readonly string[];
  /** What memory must not give the model any more (it stopped being true). */
  readonly notRecalled?: readonly string[];
  /** What the answer should say (checked on real models; the fake says it by script). */
  readonly answer?: readonly string[];
}

export interface EvalScenario {
  readonly id: string;
  readonly about: string;
  /** Files of the project, by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Each session starts a new conversation, with memory from the earlier ones. */
  readonly sessions: readonly (readonly EvalTurn[])[];
  readonly expect?: {
    /** Words that some memory stored in the project's room must hold. */
    readonly stored?: readonly string[];
    /** At most this many memories stored by the model (more is needless). */
    readonly maxStored?: number;
    /** Text that no stored memory may hold. */
    readonly neverStored?: readonly string[];
    /** Text that no tool may show the model, nor the model say (nor any memory hold). */
    readonly neverShown?: readonly string[];
    /** Files that must hold this text afterwards. */
    readonly files?: Readonly<Record<string, string>>;
    /** Files that must be as they were. */
    readonly unchanged?: readonly string[];
  };
}

export interface TurnMeasure {
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input read from or written to the prompt cache. */
  readonly cacheTokens: number;
}

export interface ScenarioResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  /** Things memory had to bring back, and how many it did. */
  readonly recallExpected: number;
  readonly recallFound: number;
  /** Memories the model stored, beyond what the scenario allows. */
  readonly needless: number;
  /** Repeated memories the duplicate guard refused. */
  readonly duplicatesRefused: number;
  readonly turns: readonly TurnMeasure[];
}

export interface EvalContext {
  readonly grafenoUrl: string;
  /** The model for one session, given the fake model's script for it. */
  readonly model: (script: FakeTurn[]) => Model;
  readonly embedder?: Embedder;
  /** Each run its own projects, so runs on one server never mix. */
  readonly runId?: string;
}

const has = (text: string, phrase: string) => normalize(text).includes(normalize(phrase));

/** Runs one scenario end to end: real memory (Grafeno), real tools, the given model. */
export async function runScenario(
  scenario: EvalScenario,
  context: EvalContext,
): Promise<ScenarioResult> {
  const failures: string[] = [];
  const root = await mkdtemp(join(tmpdir(), `ga-eval-${scenario.id}-`));
  const project = {
    name: `eval-${scenario.id}-${context.runId ?? randomUUID().slice(0, 6)}`,
    path: root,
  };
  const config: Config = {
    grafenoUrl: context.grafenoUrl,
    agentKey: "eval-agent-key-not-a-secret",
    namespace: "eval",
    model: "eval",
    embedder: "none",
    palace: "shared",
  };
  const real = grafenoVault(config);
  const stored: string[] = [];
  let duplicatesRefused = 0;
  const vault: Vault = {
    namespace: real.namespace,
    tools: () => real.tools(),
    call: async (name, args) => {
      const answer = await real.call(name, args);
      if (name === "remember" && args.name !== project.name && answerId(answer) !== undefined) {
        stored.push(answerId(answer) ?? "");
      }
      return answer;
    },
  };
  const seen: string[] = []; // everything tools returned, to look for leaks
  const turns: TurnMeasure[] = [];
  let recallExpected = 0;
  let recallFound = 0;

  try {
    for (const [path, content] of Object.entries(scenario.files ?? {})) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const workspace = new Workspace(root);

    for (const session of scenario.sessions) {
      const memory = await MemorySession.start({
        vault,
        project,
        knownSecrets: [EVAL_SECRET, config.agentKey],
        ...(context.embedder ? { embedder: context.embedder } : {}),
      });
      const system = `${memory.systemPrompt(SYSTEM_PROMPT)}\n\n${toolsPrompt(workspace)}`;
      let answers: boolean[] = [];
      const approve: Approver = () => answers.shift() ?? false;
      let prepared = "";
      const agent = new Agent({
        model: context.model(session.map((turn) => turn.fake)),
        system,
        tools: new ToolRegistry(
          [...projectTools(workspace, { web: false }), ...(await memory.tools())],
          approve,
          {
            redact: [config.agentKey],
          },
        ),
        prepare: async (message) => {
          prepared = await memory.beforeTurn(message);
          return prepared;
        },
      });
      try {
        for (const turn of session) {
          answers = [...(turn.approve ?? [])];
          const started = Date.now();
          const done = await agent.turn(turn.user, {
            onEvent: (event) => {
              if (event.type === "tool_result") seen.push(event.outcome.content);
            },
          });
          turns.push({
            ms: Date.now() - started,
            inputTokens: done.result.usage.inputTokens,
            outputTokens: done.result.usage.outputTokens,
            cacheTokens: done.result.usage.cacheReadTokens + done.result.usage.cacheWriteTokens,
          });
          const given = `${system}\n${prepared}`;
          for (const phrase of turn.recall ?? []) {
            recallExpected++;
            if (has(given, phrase)) recallFound++;
            else failures.push(`"${turn.user}": memory did not bring back "${phrase}"`);
          }
          for (const phrase of turn.notRecalled ?? []) {
            if (has(prepared, phrase))
              failures.push(`"${turn.user}": memory still gave "${phrase}"`);
          }
          for (const phrase of turn.answer ?? []) {
            if (!has(done.result.text, phrase))
              failures.push(`"${turn.user}": the answer lacks "${phrase}"`);
          }
          seen.push(done.result.text);
        }
      } finally {
        await agent.close();
      }
    }

    // What the model stored.
    const texts: string[] = [];
    for (const id of stored) {
      const node = await real.call("get_node", { id });
      const data = (node.data ?? JSON.parse(node.text)) as { text?: string };
      texts.push(data.text ?? "");
    }
    duplicatesRefused = seen.filter((text) => text.startsWith("Already in memory")).length;
    const expect = scenario.expect ?? {};
    for (const phrase of expect.stored ?? []) {
      if (!texts.some((text) => has(text, phrase)))
        failures.push(`nothing stored holds "${phrase}"`);
    }
    const needless = Math.max(0, stored.length - (expect.maxStored ?? Infinity));
    if (needless > 0) {
      failures.push(
        `stored ${String(stored.length)} memories, at most ${String(expect.maxStored)} needed`,
      );
    }
    for (const secret of [...(expect.neverStored ?? []), ...(expect.neverShown ?? [])]) {
      if (texts.some((text) => text.includes(secret))) {
        failures.push(`a stored memory holds "${secret}"`);
      }
    }
    for (const secret of expect.neverShown ?? []) {
      if (seen.some((text) => text.includes(secret))) {
        failures.push(`the model was shown "${secret}"`);
      }
    }
    for (const [path, phrase] of Object.entries(expect.files ?? {})) {
      const text = await readFile(join(root, path), "utf8").catch(() => "");
      if (!text.includes(phrase)) failures.push(`${path} does not hold "${phrase}"`);
    }
    for (const path of expect.unchanged ?? []) {
      const text = await readFile(join(root, path), "utf8").catch(() => undefined);
      if (text !== scenario.files?.[path]) failures.push(`${path} was changed`);
    }

    // Memory left in order: Grafeno's review of the project's palace.
    const review = await real.call("palace_review", { palace: project.name });
    const proposals =
      ((review.data ?? JSON.parse(review.text)) as { proposals?: unknown[] }).proposals ?? [];
    if (proposals.length > 0)
      failures.push(`the palace review proposes: ${JSON.stringify(proposals)}`);

    return {
      id: scenario.id,
      passed: failures.length === 0,
      failures,
      recallExpected,
      recallFound,
      needless,
      duplicatesRefused,
      turns,
    };
  } catch (error) {
    failures.push(`it failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      id: scenario.id,
      passed: false,
      failures,
      recallExpected,
      recallFound,
      needless: 0,
      duplicatesRefused,
      turns,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
