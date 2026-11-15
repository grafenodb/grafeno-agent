import { Agent, type AgentTurn } from "../agent/agent.js";
import {
  findSkills,
  skillCatalog,
  skillRoots,
  skillTool,
  type SkillRoot,
} from "../skills/skills.js";
import { PROVIDER_SECRET_ENV } from "../providers/index.js";
import { SYSTEM_PROMPT } from "../agent/builtin-tools.js";
import { ToolRegistry, type Approver, type Tool } from "../agent/tools.js";
import type { Config } from "../config.js";
import type { Embedder } from "../embed/types.js";
import { detectProject, gitRef } from "../memory/project.js";
import { DEFAULT_LIFECYCLE, shouldRenew, type LifecyclePolicy } from "./lifecycle.js";
import { MemorySession, type AgentName, type Recall } from "../memory/session.js";
import { grafenoVault, type Vault } from "../memory/vault.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import type { ModelChoice, Provider } from "../providers/types.js";
import {
  ModelError,
  NO_USAGE,
  type ModelErrorKind,
  type Model,
  type ModelEvent,
  type ToolCall,
  type Usage,
  type UsageWindow,
} from "../model/index.js";
import {
  previousConversation,
  SessionStore,
  type SavedSession,
  type SessionSummary,
} from "../sessions/store.js";
import { projectTools, toolsPrompt } from "../tools/index.js";
import { detectLanguage, withLanguage } from "../agent/language.js";
import {
  decide,
  settingsPermissionMode,
  type PermissionMode,
  type PermissionScope,
} from "../agent/permissions.js";
import type { PluginState } from "../plugins/index.js";
import { Workspace } from "../tools/workspace.js";

/** Errors after which the model's conversation is gone. */
const ENDS_CONVERSATION = new Set<ModelErrorKind>(["cancelled", "lost", "timeout"]);

export interface AgentSessionOptions {
  readonly config: Config;
  /** Who the agent is in Grafeno, when it said. */
  readonly identity?: AgentName;
  readonly embedder?: Embedder;
  /** Where conversations are kept. Default: the user's data folder. */
  readonly store?: SessionStore;
  /** The folder the agent runs in. Default: the current one. */
  readonly cwd?: string;
  /** Where the reasoning comes from. Default: Claude through Claude Code. */
  readonly provider?: Provider;
  /** Makes the model for a choice; for tests. Default: the provider's. */
  readonly makeModel?: (choice: ModelChoice) => Model;
  /** The vault; for tests. Default: Grafeno at the settings' server. */
  readonly vault?: Vault;
  /** The project's tools; for tests. Default: files, commands and the web. */
  readonly tools?: (workspace: Workspace) => Tool[];
  /** Tools the interface adds (such as `delegate`, to start sub-agents). */
  readonly extraTools?: readonly Tool[];
  /**
   * What the interface connected for the session (external MCP servers):
   * what to tell the person, each server's state, and what to close with it.
   */
  readonly extensions?: SessionExtensions;
  /** Where skills are read from; default: the project's and the user's (skillRoots). */
  readonly skillRoots?: readonly SkillRoot[];
  /**
   * When to renew the conversation (see lifecycle.ts); `false`: never.
   * Default: after a pause that leaves the cache cold with a large context,
   * or when the context is nearly full.
   */
  readonly lifecycle?: Partial<LifecyclePolicy> | false;
  /** The clock; for tests. */
  readonly now?: () => Date;
}

/** What the model is told on each message while the session is unattended. */
export const UNATTENDED_NOTE =
  "[Unattended: nobody is watching this session. Do not ask the user questions or wait for confirmations: decide sensibly, keep working until the task is done (plan it, run it, check it, retry what fails a few times, then try another way), and report what you did at the end. Tools run without asking, except what is never allowed.]";

/** Characters of the conversation carried into a renewed one. */
const RENEWAL_CARRY = 3000;

/** External MCP servers and plugins connected for a session. */
export interface SessionExtensions {
  /** Things to tell the person: a server not reached, a variable not set, a plugin not connected. */
  readonly notes: readonly string[];
  readonly mcp: readonly {
    readonly name: string;
    readonly tools: number;
    readonly error?: string;
  }[];
  /** The plugins turned on (GitHub, GitLab…), each one's state. */
  readonly plugins?: readonly PluginState[];
  close(): Promise<void>;
}

export interface SendOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ModelEvent) => void;
  /** Told what memory brought to the message, before the model sees it. */
  readonly onMemory?: (recall: Recall) => void;
  /** Told when the conversation was renewed before this message, and why. */
  readonly onRenewal?: (notice: string) => void;
}

/**
 * One run of the agent on a project, behind whatever interface shows it:
 * memory, tools, the model (which may change), and the conversation, which
 * is kept on disk so that it can be taken up again.
 */
export class AgentSession {
  /** Asked before a tool that needs permission runs; the interface sets it. */
  approve: Approver = () => false;

  /** This session's own permission mode, over the agent-wide one (/permissions). */
  #permissions: { mode: PermissionMode; subagents: boolean } | undefined;
  /** Unattended: nobody is watching; the session and its sub-agents go on alone. */
  #unattended: { before: { mode: PermissionMode; subagents: boolean } | undefined } | undefined;

  /** The mode the session's own calls are decided by: its own, else the agent-wide one. */
  get permissionMode(): PermissionMode {
    return this.#permissions?.mode ?? settingsPermissionMode();
  }

  /** Where the mode in force comes from. */
  get permissionScope(): PermissionScope {
    if (!this.#permissions) return "agent";
    return this.#permissions.subagents ? "session+subagents" : "session";
  }

  /** The mode this session's sub-agents get: its own when it covers them, else the agent-wide one. */
  get subagentPermissions(): PermissionMode {
    return this.#permissions?.subagents ? this.#permissions.mode : settingsPermissionMode();
  }

  /**
   * Sets this session's permission mode (`session`: its own calls;
   * `session+subagents`: and its sub-agents'); `undefined` goes back to the
   * agent-wide mode. The agent-wide mode is a setting, saved elsewhere.
   */
  setPermissions(mode: PermissionMode | undefined, subagents = false): void {
    this.#permissions = mode === undefined ? undefined : { mode, subagents };
  }

  get unattended(): boolean {
    return this.#unattended !== undefined;
  }

  /**
   * Unattended operation: permissions skipped for the session and its
   * sub-agents, plans run without being confirmed, and the model told that
   * nobody is watching, to decide and go on until the task is done. Off,
   * the permissions go back to what they were.
   */
  setUnattended(on: boolean): void {
    if (on && !this.#unattended) {
      this.#unattended = { before: this.#permissions };
      this.#permissions = { mode: "skip", subagents: true };
    } else if (!on && this.#unattended) {
      this.#permissions = this.#unattended.before;
      this.#unattended = undefined;
    }
  }

  /** Decides a call by the permission mode, then asks the interface when it must. */
  async #decide(
    call: Parameters<Approver>[0],
    tool: Parameters<Approver>[1],
    decision: Parameters<Approver>[2],
  ): Promise<boolean> {
    const decided = decide(this.permissionMode, tool, call.input, decision);
    if (decided.verdict === "allow") return true;
    if (decided.verdict === "never") return false;
    return this.approve(call, tool, { ...decision, reason: decided.reason });
  }

  #agent: Agent | undefined;
  #choice: ModelChoice;
  /** The exact model answering, once the provider said. */
  #modelId: string | undefined;
  #context: { used: number; window?: number } | undefined;
  #provider: Provider | undefined;
  #onMemory: ((recall: Recall) => void) | undefined;
  #record: SavedSession;
  /** The earlier conversation, to give the model with the next message. */
  #carry: string | undefined;
  #spentBefore: Usage = NO_USAGE;
  #turnsBefore = 0;
  #windows: readonly UsageWindow[] = [];
  /** When the last message ended. */
  #lastActivity: Date | undefined;
  #turnsSinceRenewal = 0;
  #renewals = 0;
  /** The language the user writes in, from their latest message that said it. */
  #language: string | undefined;

  private constructor(
    private readonly options: AgentSessionOptions,
    readonly memory: MemorySession,
    readonly vault: Vault,
    readonly workspace: Workspace,
    private readonly memoryTools: readonly Tool[],
    readonly store: SessionStore,
  ) {
    const { claudeModel, claudeEffort } = options.config;
    this.#choice = {
      ...(claudeModel === undefined ? {} : { model: claudeModel }),
      ...(claudeEffort === undefined ? {} : { effort: claudeEffort }),
    };
    this.#record = store.create(memory.project.name, this.model);
  }

  static async start(options: AgentSessionOptions): Promise<AgentSession> {
    const { config } = options;
    const project = detectProject(options.cwd ?? process.cwd(), config.project);
    const vault = options.vault ?? grafenoVault(config);
    const memory = await MemorySession.start({
      vault,
      project,
      palace: config.palace,
      knownSecrets: [config.agentKey],
      ...(options.identity ? { agent: options.identity } : {}),
      ...(options.embedder ? { embedder: options.embedder } : {}),
      ...(project.path ? { gitRef: () => gitRef(project.path ?? ".") } : {}),
      ...(config.memoryLimits ? { limits: config.memoryLimits } : {}),
    });
    const workspace = new Workspace(project.path ?? options.cwd ?? process.cwd());
    const store = options.store ?? new SessionStore(undefined, [config.agentKey]);
    return new AgentSession(options, memory, vault, workspace, await memory.tools(), store);
  }

  get config(): Config {
    return this.options.config;
  }

  get identity(): AgentName | undefined {
    return this.options.identity;
  }

  /** Where the reasoning comes from. */
  get provider(): Provider {
    this.#provider ??= this.options.provider ?? new ClaudeCodeProvider();
    return this.#provider;
  }

  /** The model asked for (`default` when the provider's own). */
  get model(): string {
    return this.#choice.model ?? "default";
  }

  /** The effort asked for; undefined when the provider's own. */
  get effort(): string | undefined {
    return this.#choice.effort;
  }

  /** The exact model that answered last (such as `claude-opus-5-5`), once known. */
  get modelId(): string | undefined {
    return this.#modelId;
  }

  /** How full the model's context was at the last request, when the provider said. */
  get context(): { used: number; window?: number } | undefined {
    return this.#context;
  }

  /** The conversation being had (and kept). */
  get conversation(): SavedSession {
    return this.#record;
  }

  get usage(): Usage {
    const now = this.#agent?.usage ?? NO_USAGE;
    return {
      inputTokens: this.#spentBefore.inputTokens + now.inputTokens,
      outputTokens: this.#spentBefore.outputTokens + now.outputTokens,
      cacheReadTokens: this.#spentBefore.cacheReadTokens + now.cacheReadTokens,
      cacheWriteTokens: this.#spentBefore.cacheWriteTokens + now.cacheWriteTokens,
    };
  }

  get windows(): readonly UsageWindow[] {
    return this.#agent?.windows.length ? this.#agent.windows : this.#windows;
  }

  /** Turns this run of the agent took, across models and conversations. */
  get turns(): number {
    return this.#turnsBefore + (this.#agent?.turns ?? 0);
  }

  /** Conversations renewed so far in this run. */
  get renewals(): number {
    return this.#renewals;
  }

  /**
   * Renews the conversation before a message when keeping it would cost
   * more than starting again (lifecycle.ts): a checkpoint carries the state
   * forward, the compact resume is built again, and the new conversation
   * gets the end of the old one. Never in the middle of a turn: only here,
   * before a message is sent.
   */
  async #renewIfDue(options: SendOptions): Promise<void> {
    const policy = this.options.lifecycle;
    if (policy === false || this.#agent === undefined) return;
    const decision = shouldRenew(
      {
        ...(this.#lastActivity ? { lastActivity: this.#lastActivity } : {}),
        now: this.#now(),
        ...(this.#context ? { context: this.#context } : {}),
        turnsSinceRenewal: this.#turnsSinceRenewal,
      },
      { ...DEFAULT_LIFECYCLE, ...policy },
    );
    if (!decision.renew) return;
    const saved = await this.memory.carryCheckpoint(decision.reason).catch(() => false);
    await this.memory.refreshResume().catch(() => undefined);
    const tail = previousConversation(this.#record.entries, RENEWAL_CARRY);
    await this.#dropAgent();
    this.#carry = tail || undefined;
    this.#context = undefined;
    this.#turnsSinceRenewal = 0;
    this.#renewals++;
    const notice = `Started a fresh conversation: ${decision.reason}. It goes on from ${saved ? "a checkpoint saved just now" : "the latest checkpoint"}, the compact resume and the end of the conversation.`;
    this.store.add(this.#record, { kind: "notice", text: notice });
    options.onRenewal?.(notice);
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Sends a message; what happens is kept in the conversation as it comes. */
  async send(text: string, options: SendOptions = {}): Promise<AgentTurn> {
    await this.#renewIfDue(options);
    const agent = this.#ensureAgent();
    this.#onMemory = options.onMemory;
    this.store.add(this.#record, { kind: "user", text });
    const carried = this.#carry;
    this.#carry = undefined;
    const calls = new Map<string, ToolCall>();
    try {
      const turn = await agent.turn(carried === undefined ? text : `${carried}\n\n${text}`, {
        ...(options.signal ? { signal: options.signal } : {}),
        onEvent: (event) => {
          if (event.type === "tool_call") calls.set(event.call.id, event.call);
          if (event.type === "model_info") this.#modelId = event.model;
          if (event.type === "context") {
            this.#context = {
              used: event.used,
              ...((event.window ?? this.#context?.window) === undefined
                ? {}
                : { window: event.window ?? this.#context?.window }),
            } as { used: number; window?: number };
          }
          if (event.type === "tool_result") {
            const call = calls.get(event.callId);
            this.store.add(this.#record, {
              kind: "tool",
              text: `${call ? describeCall(call) : "tool"}\n${event.outcome.content.slice(0, 2000)}`,
              ...(event.outcome.isError === true ? { failed: true } : {}),
            });
          }
          options.onEvent?.(event);
        },
      });
      if (turn.result.text !== "") {
        this.store.add(this.#record, { kind: "assistant", text: turn.result.text });
      }
      return turn;
    } catch (error) {
      if (error instanceof ModelError && ENDS_CONVERSATION.has(error.kind)) {
        // The model's conversation ended with this turn (a cancel stops it):
        // the next one starts from what was said, as data.
        this.#carry = previousConversation(this.#record.entries) || undefined;
      } else if (carried !== undefined) {
        // Not given to the model after all: give it the conversation next time.
        this.#carry = carried;
      }
      throw error;
    } finally {
      this.#lastActivity = this.#now();
      this.#turnsSinceRenewal++;
    }
  }

  /**
   * Changes the provider the session reasons with; the conversation goes on
   * with it, given as data. Its model and effort start as the provider's own
   * ("Auto"), since another provider's models mean nothing to it.
   */
  async setProvider(provider: Provider): Promise<void> {
    if (provider.id === this.provider.id) return;
    await this.#dropAgent();
    this.#provider = provider;
    this.#choice = {};
    this.#modelId = undefined;
    this.#context = undefined;
    this.#carry = previousConversation(this.#record.entries) || undefined;
    this.#record.model = this.model;
  }

  /** Changes the model; the conversation goes on with the new one. */
  async setModel(alias: string): Promise<void> {
    const next = alias === "default" ? undefined : alias;
    if (next === this.#choice.model) return;
    await this.#switch({
      ...withoutModel(this.#choice),
      ...(next === undefined ? {} : { model: next }),
    });
    this.#modelId = undefined;
    this.#record.model = this.model;
  }

  /** Changes how hard the model thinks; `default` is the provider's own. */
  async setEffort(effort: string): Promise<void> {
    const next = effort === "default" ? undefined : effort;
    if (next === this.#choice.effort) return;
    const rest: ModelChoice = this.#choice.model === undefined ? {} : { model: this.#choice.model };
    await this.#switch({ ...rest, ...(next === undefined ? {} : { effort: next }) });
  }

  async #switch(choice: ModelChoice): Promise<void> {
    await this.#dropAgent();
    this.#choice = choice;
    this.#carry = previousConversation(this.#record.entries) || undefined;
  }

  /** Starts a new conversation; the current one stays kept. */
  async newConversation(): Promise<void> {
    await this.#dropAgent();
    this.#record = this.store.create(this.memory.project.name, this.model);
    this.#carry = undefined;
  }

  /** The project's kept conversations, the latest first. */
  conversations(): SessionSummary[] {
    return this.store.list(this.memory.project.name);
  }

  /** Takes up a kept conversation: the model gets it with the next message. */
  async resume(id: string): Promise<SavedSession | undefined> {
    const saved = this.store.load(this.memory.project.name, id);
    if (saved === undefined) return undefined;
    await this.#dropAgent();
    this.#record = saved;
    this.#carry = previousConversation(saved.entries) || undefined;
    return saved;
  }

  /** Asks the model to save a checkpoint of where the work stands. */
  async checkpoint(options: SendOptions = {}): Promise<AgentTurn> {
    return this.send(this.memory.endOfSession(), options);
  }

  async close(): Promise<void> {
    await this.#dropAgent();
    await this.options.extensions?.close().catch(() => undefined);
  }

  /** What was connected for the session (external MCP servers, plugins), when anything was. */
  get extensions(): SessionExtensions | undefined {
    return this.options.extensions;
  }

  /**
   * Grafeno's own MCP server: the memory tools the agent uses from it (its
   * namespace's tools endpoint). Always on: the agent's memory is there.
   */
  get grafenoMcp(): { readonly namespace: string; readonly tools: readonly string[] } {
    return { namespace: this.vault.namespace, tools: this.memoryTools.map((t) => t.name) };
  }

  #ensureAgent(): Agent {
    if (this.#agent) return this.#agent;
    const { config } = this.options;
    const model = this.options.makeModel?.(this.#choice) ?? this.provider.create(this.#choice);
    const own =
      this.options.tools?.(this.workspace) ??
      projectTools(this.workspace, {
        hiddenEnv: ["GRAFENO_AGENT_KEY", ...PROVIDER_SECRET_ENV],
      });
    // Skills: what each is for goes in the instructions; the `skill` tool loads one.
    const skills = findSkills(this.options.skillRoots ?? skillRoots(this.workspace.root)).skills;
    const catalog = skillCatalog(skills);
    this.#agent = new Agent({
      model,
      system: `${this.memory.systemPrompt(SYSTEM_PROMPT)}\n\n${toolsPrompt(this.workspace)}${catalog ? `\n\n${catalog}` : ""}`,
      tools: new ToolRegistry(
        [
          ...own,
          ...this.memoryTools,
          ...(skills.length > 0 ? [skillTool(() => skills)] : []),
          ...(this.options.extraTools ?? []),
        ],
        (call, tool, decision) => this.#decide(call, tool, decision),
        { redact: [config.agentKey] },
      ),
      prepare: async (message) => {
        const prepared = await this.memory.beforeTurn(message);
        this.#onMemory?.(this.memory.lastRecall);
        // The answer goes in the user's language; a message too short to
        // tell ("ok", "sí") keeps the one before.
        // The agent's own end-of-session message says nothing of the user's language.
        if (message !== this.memory.endOfSession()) {
          this.#language = detectLanguage(message) ?? this.#language;
        }
        const withNote = withLanguage(prepared, message, this.#language);
        return this.#unattended ? `${UNATTENDED_NOTE}\n\n${withNote}` : withNote;
      },
    });
    return this.#agent;
  }

  async #dropAgent(): Promise<void> {
    const agent = this.#agent;
    if (!agent) return;
    this.#agent = undefined;
    this.#spentBefore = {
      inputTokens: this.#spentBefore.inputTokens + agent.usage.inputTokens,
      outputTokens: this.#spentBefore.outputTokens + agent.usage.outputTokens,
      cacheReadTokens: this.#spentBefore.cacheReadTokens + agent.usage.cacheReadTokens,
      cacheWriteTokens: this.#spentBefore.cacheWriteTokens + agent.usage.cacheWriteTokens,
    };
    this.#turnsBefore += agent.turns;
    if (agent.windows.length > 0) this.#windows = agent.windows;
    await agent.close();
  }
}

function withoutModel(choice: ModelChoice): ModelChoice {
  return choice.effort === undefined ? {} : { effort: choice.effort };
}

/** What a tool call is about, in a few words: `read_file parser.js`. */
export function describeCall(call: Pick<ToolCall, "name" | "input">): string {
  const input = call.input;
  const main = ["path", "command", "url", "pattern", "query", "name", "summary", "text", "id"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value !== "");
  const detail = main ?? (Object.keys(input).length > 0 ? JSON.stringify(input) : "");
  const short = detail.replace(/\s+/g, " ");
  return `${call.name}${short ? ` ${short.length > 80 ? `${short.slice(0, 79)}…` : short}` : ""}`;
}
