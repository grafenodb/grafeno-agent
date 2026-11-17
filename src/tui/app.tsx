import { Box, measureElement, Text, useApp, useWindowSize, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { readEnvironment, type Environment } from "../app/environment.js";
import type { AppServices } from "../app/services.js";
import { chatProvider } from "../providers/chat.js";
import { describeCall, type AgentSession } from "../app/session.js";
import { describeError } from "../chat.js";
import type { ToolCall } from "../model/index.js";
import {
  API_KEY_PROVIDERS,
  autoMembers,
  autoMode,
  isLocalProvider,
  providerIds,
  autoModels,
} from "../providers/index.js";
import { mostRoom } from "../app/triage.js";
import type { ModelOption, ProviderStatus, ProviderUsage } from "../providers/types.js";
import type { Recall } from "../memory/session.js";
import type { Entry } from "../sessions/store.js";
import { COMMANDS, parseCommand } from "./commands.js";
import {
  ago,
  bar,
  compact,
  effortLabel,
  modelLine,
  modelName,
  shortResets,
  usageTone,
} from "./labels.js";
import { Glyph, Logo } from "./logo.js";
import { Markdown } from "./markdown.js";
import { RunView, type RunTask } from "./run-view.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ActiveWorker } from "../orchestrator/workers.js";
import { describeReport } from "../orchestrator/telemetry.js";
import { delegateTool } from "../app/delegate.js";
import { describeSkills } from "../app/skills-command.js";
import { findSkills, skillRoots } from "../skills/skills.js";
import type { Provider } from "../providers/types.js";
import {
  withActivity,
  withState,
  withTasks,
  withWorkers,
  type SubAgent,
  withReport,
} from "./agents.js";
import { AgentsPanel, AgentView, agentKey } from "./agents-panel.js";
import { ClickArea, Clickable } from "./clicks.js";
import { InputArea, useGlobalKeys, useKeys } from "./core/input.js";
import { commandAction, commandActions, paletteItems, VIEW_ACTIONS } from "./core/actions.js";
import { ProjectsPanel } from "./projects.js";
import { deleteProjectEverywhere, describeDeletion } from "../app/project-delete.js";
import { projectFootprint } from "../projects.js";
import { sessionsDir } from "../sessions/store.js";
import { dataDir } from "../data-dir.js";
import { SessionsPanel } from "./sessions.js";
import {
  ActionGroup,
  ActionLine,
  actionOutput,
  describeAction,
  groupSummary,
  summarizeOutcome,
  type Action,
  type ActionRecord,
} from "./activity.js";
import {
  PERMISSION_LABELS,
  settingsPermissionMode,
  type PermissionMode,
  type PermissionScope,
} from "../agent/permissions.js";

/** How each permission scope is named. */
const SCOPE_LABELS: Readonly<Record<PermissionScope, string>> = {
  agent: "The whole agent",
  session: "This session",
  "session+subagents": "This session and its sub-agents",
};
import { describePlan } from "../app/orchestrate.js";
import { describeResult } from "../orchestrator/result.js";
import { useWheel } from "./mouse.js";
import { PalacePanel } from "./palace.js";
import { Picker, type PickerItem } from "./picker.js";
import { Prompt } from "./prompt.js";
import { ProviderPanel } from "./provider.js";
import { isNoModel, NO_MODEL, NO_MODEL_TEXT, NoModelProvider } from "../providers/none.js";
import { ConnectMenu, KeyEntry, sectionOf } from "./connect-menu.js";
import { LocalPanel } from "./local-connect.js";
import {
  complianceText,
  connectionRecord,
  localConnectionRecord,
  describeConnections,
  stateOf,
} from "../app/connections.js";
import { apiKeySpec } from "../providers/api-key.js";
import { PROVIDER_PROFILES, providerEnabled, type ConnectionType } from "../providers/profiles.js";
import { Sidebar, type AutoUsage } from "./sidebar.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export type { AppServices } from "../app/services.js";

/** Days between upkeeps before the interface suggests one. */
const UPKEEP_EVERY_DAYS = 7;
/** The side panel's width, and the narrowest window that still shows it. */
const SIDEBAR = 38;
const SIDEBAR_FROM = 100;
/** The agents panel's width (left), and the narrowest window that shows it with the side panel. */
const AGENTS = 30;
const AGENTS_FROM = 140;
/** Items kept on screen: older ones stay in the kept conversation. */
const KEEP = 300;

type Tone = "info" | "success" | "warning" | "error";

type Item =
  | { readonly id: number; readonly kind: "user"; readonly text: string }
  | { readonly id: number; readonly kind: "assistant"; readonly text: string }
  | {
      readonly id: number;
      readonly kind: "tool";
      readonly label: string;
      readonly failed: boolean;
      readonly detail?: string;
      /** How it reads: a verb, a target, what came of it (absent for restored ones). */
      readonly action?: Action;
      /** What it did, shown when its group is unfolded. */
      readonly output?: string;
    }
  | {
      readonly id: number;
      readonly kind: "result";
      /** How long the work took, and what it did, in a line. */
      readonly text: string;
      readonly failed: boolean;
    }
  | { readonly id: number; readonly kind: "notice"; readonly text: string; readonly tone: Tone }
  | { readonly id: number; readonly kind: "memory"; readonly recall: Recall }
  | {
      readonly id: number;
      readonly kind: "block";
      readonly title: string;
      readonly lines: readonly string[];
      /** Folded under its title until clicked (or ctrl+o): details few need. */
      readonly foldable?: boolean;
      /** Green when the work it reports went well, amber when not. */
      readonly tone?: "success" | "warning";
    };

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Phase = "starting" | "setup-memory" | "setup-provider" | "ready" | "offline";
type Mode =
  | "chat"
  | "models"
  | "leader"
  | "effort"
  | "mode"
  | "palette"
  | "resume"
  | "connect"
  | "palace"
  | "permissions"
  | "projects"
  | "plan"
  | "runs"
  | "agents"
  | "exiting";

/** A run being watched: its tasks and who works on them. */
interface Watched {
  readonly runId: string;
  readonly state: string;
  readonly tasks: readonly RunTask[];
  readonly workers: readonly ActiveWorker[];
}

interface Approval {
  readonly what: string;
  readonly reason?: string;
  readonly resolve: (allowed: boolean) => void;
}

interface LiveTool {
  readonly action?: Action;
  readonly id: string;
  readonly label: string;
}

/**
 * The interface, clickable: what a command or a key does, a click on the
 * menu, a list, a panel or a button does too.
 */
export function App({ services }: { readonly services: AppServices }): ReactNode {
  // One reader of the terminal's input: keys and mouse go to whoever has the focus.
  return (
    <InputArea>
      <ClickArea>
        <AppBody services={services} />
      </ClickArea>
    </InputArea>
  );
}

function AppBody({ services }: { readonly services: AppServices }): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<Phase>(() =>
    services.needsSetup() ? "setup-memory" : "starting",
  );
  const [session, setSession] = useState<AgentSession | undefined>(undefined);
  // The provider the chat reasons with: the session's, which /connect may change.
  const provider = session?.provider ?? services.providers[0];
  // General Auto (B7c): each message is triaged, and may be orchestrated across providers.
  const [auto, setAuto] = useState(() => autoMode(process.env));
  // The providers Auto includes (AGENT_AUTO_PROVIDERS): by default, the official CLIs only.
  // In Auto, the usage of each provider it includes, for the side panel.
  const [autoUsage, setAutoUsage] = useState<readonly AutoUsage[]>([]);
  /** /leader: the models of the providers in Auto, to choose the runs' leader from. */
  const [leaderItems, setLeaderItems] = useState<PickerItem[]>([]);
  const [autoIds, setAutoIds] = useState<readonly string[]>(() => {
    try {
      return autoMembers(process.env);
    } catch {
      return [];
    }
  });
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<Mode>("chat");
  // Where /connect is: its menu, a section, a key being typed, or managing one connection.
  const [connectView, setConnectView] = useState<
    | { kind: "menu" }
    | { kind: "section"; type: ConnectionType; back?: "local" }
    | { kind: "key"; provider: Provider; back: ConnectionType }
    | { kind: "manage" }
    | { kind: "actions"; provider: Provider }
    | { kind: "billing"; provider: Provider }
    | { kind: "plan"; provider: Provider }
    | { kind: "local" }
  >({ kind: "menu" });
  /** For each provider in Auto, the models chosen (AGENT_AUTO_MODELS). */
  const [autoModelChoice, setAutoModelChoice] = useState<Record<string, string[]>>(() =>
    autoModels(process.env),
  );
  /** /permissions: the mode chosen, before its scope is. */
  const [permissionChoice, setPermissionChoice] = useState<PermissionMode | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [live, setLive] = useState("");
  const [tools, setTools] = useState<LiveTool[]>([]);
  // Permission requests wait in turn: several sub-agents may ask at once, and
  // each one must be answered, never replaced by the next.
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const approval = approvals[0];
  const setApproval = useCallback((next: Approval | undefined) => {
    if (next) setApprovals((queue) => [...queue, next]);
    else setApprovals((queue) => queue.slice(1));
  }, []);
  /** When the request on screen appeared: keys pressed just before it are not answers. */
  const approvalShown = useRef(0);
  useEffect(() => {
    if (approval) approvalShown.current = Date.now();
  }, [approval]);
  const [sent, setSent] = useState<string[]>([]);
  const [resumable, setResumable] = useState<PickerItem[]>([]);
  const [status, setStatus] = useState<ProviderStatus | undefined>(undefined);
  const [usage, setUsage] = useState<ProviderUsage | undefined>(undefined);
  /** The latest reading of the plan's usage failed: the one shown is older. */
  const [usageStale, setUsageStale] = useState(false);
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [environment, setEnvironment] = useState<Environment>({});
  const [recall, setRecall] = useState<Recall | undefined>(undefined);
  const [sidebarOn, setSidebarOn] = useState(true);
  const [scroll, setScroll] = useState(0);
  // Folded actions: all unfolded with ctrl+o; a click flips one group.
  const [allOpen, setAllOpen] = useState(false);
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  const [, setTick] = useState(0);
  const [watched, setWatched] = useState<Watched | undefined>(undefined);
  const [runChoices, setRunChoices] = useState<PickerItem[]>([]);
  // Sub-agents the main agent's runs started, and the one shown (undefined: the main agent).
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  /** The run being driven now: whose tasks the sub-agents are. */
  const runNow = useRef<string | undefined>(undefined);
  /** The main agent's `delegate` call waiting for the person to run its plan, or not. */
  const pendingPlan = useRef<((run: boolean) => void) | undefined>(undefined);
  /** Starts sub-agents for the main agent (set once the functions it needs exist). */
  const launch = useRef<((request: string, signal: AbortSignal) => Promise<string>) | undefined>(
    undefined,
  );
  const orchestration = useRef<
    | {
        orchestrator: Orchestrator;
        request?: string;
        planned?: Awaited<ReturnType<Orchestrator["plan"]>>;
        running: boolean;
      }
    | undefined
  >(undefined);
  const nextId = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const exiting = useRef(false);
  const usageAt = useRef(0);
  const started = useRef(false);

  const push = useCallback((...added: NewItem[]) => {
    setItems((current) =>
      [...current, ...added.map((item) => ({ ...item, id: nextId.current++ }))].slice(-KEEP),
    );
    setScroll(0);
  }, []);

  const notice = useCallback(
    (text: string, tone: Tone = "info") => {
      push({ kind: "notice", text, tone });
    },
    [push],
  );

  /**
   * The provider's real usage. Every minute on a timer (through the
   * providers' one-minute cache, so it is the provider's latest answer,
   * spent elsewhere too: another app, another terminal); asked anew after
   * each turn, since the turn just spent some; asked anew when forced. A
   * reading that fails keeps the last one, marked as old.
   */
  const refreshUsage = useCallback(
    async (why: "timer" | "turn" | "force" = "timer") => {
      const gap = why === "timer" ? 55_000 : 0;
      if (!provider || Date.now() - usageAt.current < gap) return;
      usageAt.current = Date.now();
      const found = await provider
        .usage(why === "timer" ? {} : { fresh: true })
        .catch(() => undefined);
      if (found) setUsage(found);
      setUsageStale(found === undefined);
    },
    [provider],
  );

  /**
   * In Auto, each included provider's usage: read through the providers'
   * one-minute cache, and only with calls that spend nothing (a plan's
   * windows, an API key's own record).
   */
  const lastAutoUsage = useRef<ReadonlyMap<string, ProviderUsage>>(new Map());
  /** The tokens each provider spent answering the chat in this session (shown for local ones). */
  const providerTokens = useRef(new Map<string, { input: number; output: number }>());
  const refreshAutoUsage = useCallback(
    async (afterTurn = false) => {
      if (!auto || autoIds.length === 0) {
        setAutoUsage([]);
        return;
      }
      const members = services.providers.filter((p) => autoIds.includes(p.id));
      const found = await Promise.all(
        members.map(async (p): Promise<AutoUsage> => {
          const current = p.id === session?.provider.id;
          // A model server of the person's own has no quota: only its tokens.
          if (isLocalProvider(p.id)) {
            const tokens = providerTokens.current.get(p.id);
            return {
              id: p.id,
              name: p.name,
              apiKey: false,
              current,
              local: true,
              ...(tokens ? { tokens } : {}),
            };
          }
          // The provider that just answered is asked anew; the others through the cache.
          const read = await p
            .usage(afterTurn && current ? { fresh: true } : {})
            .catch(() => undefined);
          // A reading that fails keeps the last one, marked as old.
          const usage = read ?? lastAutoUsage.current.get(p.id);
          return {
            id: p.id,
            name: p.name,
            apiKey: API_KEY_PROVIDERS.includes(p.id),
            current,
            ...(usage ? { usage } : {}),
            ...(read === undefined && usage ? { stale: true } : {}),
          };
        }),
      );
      lastAutoUsage.current = new Map(
        found.flatMap((m) => (m.usage ? [[m.id, m.usage] as const] : [])),
      );
      setAutoUsage(found);
    },
    [auto, autoIds, services, session],
  );

  useEffect(() => {
    void refreshAutoUsage();
  }, [refreshAutoUsage]);

  /** The connections and their state (list), with each one's detail (status). */
  const showConnections = useCallback(
    async (detailed: boolean) => {
      setBusy("Checking the connections");
      try {
        const records = await Promise.all(
          services.providers.map(async (p) => {
            const status = await p.status().catch((error: unknown) => ({
              installed: false,
              signedIn: false,
              detail: error instanceof Error ? error.message : String(error),
            }));
            // A local server's record carries its models and what each can do.
            return isLocalProvider(p.id)
              ? localConnectionRecord(p, status)
              : connectionRecord(p, status);
          }),
        );
        push({
          kind: "block",
          title: detailed ? "Connections · status" : "Connections",
          lines: [
            ...describeConnections(records, detailed),
            "",
            "/connect cli · api · plans · local · manage · disconnect <connection>",
          ],
        });
      } finally {
        setBusy(undefined);
      }
    },
    [services, push],
  );

  /** Starts a session with the settings as they are now. */
  const connect = useCallback(async () => {
    setPhase("starting");
    try {
      // The main agent may start sub-agents, on any provider.
      const fresh = await services.start({
        tools: [
          delegateTool(
            (request, signal) =>
              launch.current?.(request, signal) ??
              Promise.resolve("Sub-agents cannot be started here."),
          ),
        ],
      });
      fresh.approve = (call: ToolCall, tool, decision) =>
        new Promise<boolean>((resolve) => {
          setApproval({
            what: tool.describe ? tool.describe(call.input) : describeCall(call),
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            resolve,
          });
        });
      setSession(fresh);
      setPhase("ready");
      void fresh.provider.status().then((found) => {
        if (isNoModel(fresh.provider)) notice(found.detail, "warning");
        else if (!found.installed || !found.signedIn)
          notice(
            `${fresh.provider.name} is not ready, so no model is available yet: ${found.detail}`,
            "warning",
          );
      });
      // External MCP servers and plugins: one not reached, or a variable not set, is said.
      for (const note of fresh.extensions?.notes ?? []) notice(note, "warning");
      void readEnvironment(fresh.workspace.root).then(setEnvironment);
      const last = await fresh.memory.lastUpkeep();
      if (!last || Date.now() - last.getTime() > UPKEEP_EVERY_DAYS * 86_400_000) {
        notice(
          `Memory upkeep ${last ? `last ran ${last.toISOString().slice(0, 10)}` : "has not run yet"}: /upkeep looks after it.`,
          "warning",
        );
      }
    } catch (error) {
      setPhase("offline");
      notice(error instanceof Error ? error.message : String(error), "error");
      notice("/palace sets up the memory (Grafeno); /connect, the provider.", "warning");
    }
  }, [services, notice]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (phase === "starting") void connect();
  }, [phase, connect]);

  useEffect(() => {
    if (!provider) return;
    void provider.status().then(setStatus);
    void provider.models().then(setModels);
    void refreshUsage("force");
  }, [provider, refreshUsage]);

  // Usage spent elsewhere (another app, another terminal) shows within a
  // minute, and "n min ago" stays true while nothing else happens.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshUsage("timer");
      void refreshAutoUsage();
      setTick((t) => t + 1);
    }, 60_000);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }, [refreshUsage, refreshAutoUsage]);

  /** Runs a turn and shows it as it comes. */
  const runTurn = useCallback(
    async (active: AgentSession, text: string, shown: string | undefined, label = "Thinking") => {
      if (shown !== undefined) push({ kind: "user", text: shown });
      const controller = new AbortController();
      abort.current = controller;
      setBusy(label);
      const labels = new Map<string, string>();
      const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
      // What the turn did, for the line that closes it.
      const done: ActionRecord[] = [];
      const started = Date.now();
      let buffer = "";
      const flush = () => {
        if (buffer.trim() !== "") push({ kind: "assistant", text: buffer });
        buffer = "";
        setLive("");
      };
      try {
        const answering = active.provider.id;
        const turn = await active.send(text, {
          signal: controller.signal,
          onRenewal: (text) => {
            notice(text, "info");
          },
          onMemory: (recall) => {
            setRecall(recall);
            if (shown !== undefined) push({ kind: "memory", recall });
          },
          onEvent: (event) => {
            switch (event.type) {
              case "text":
                buffer += event.text;
                setLive(buffer);
                setScroll(0);
                break;
              case "tool_call": {
                flush();
                const callLabel = describeCall(event.call);
                labels.set(event.call.id, callLabel);
                calls.set(event.call.id, event.call);
                setTools((current) => [
                  ...current,
                  {
                    id: event.call.id,
                    label: callLabel,
                    action: describeAction(event.call.name, event.call.input),
                  },
                ]);
                break;
              }
              case "tool_result": {
                setTools((current) => current.filter((t) => t.id !== event.callId));
                const first = event.outcome.content.split("\n", 1)[0] ?? "";
                const call = calls.get(event.callId);
                const failed = event.outcome.isError === true;
                push({
                  kind: "tool",
                  label: labels.get(event.callId) ?? "tool",
                  failed,
                  ...(failed ? { detail: first.slice(0, 160) } : {}),
                  ...(call
                    ? {
                        action: {
                          ...describeAction(call.name, call.input),
                          summary: summarizeOutcome(call.name, event.outcome.content, failed),
                        },
                        output: actionOutput(call.name, call.input, event.outcome.content, failed),
                      }
                    : {}),
                });
                if (call) {
                  done.push({
                    action: describeAction(call.name, call.input),
                    failed,
                  });
                }
                break;
              }
              case "model_info":
              case "context":
                setTick((t) => t + 1);
                break;
              default:
                break;
            }
          },
        });
        flush();
        {
          const before = providerTokens.current.get(answering) ?? { input: 0, output: 0 };
          const u = turn.result.usage;
          providerTokens.current.set(answering, {
            input: before.input + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
            output: before.output + u.outputTokens,
          });
        }
        if (turn.restarted) {
          notice("The conversation with the model had ended and was started again.", "warning");
        }
        if (turn.result.stopReason === "max_steps")
          notice(
            `It worked through ${String(turn.result.steps)} steps without finishing and paused: say "continue" to go on.`,
            "warning",
          );
        else if (turn.result.stopReason === "max_tokens")
          notice("The answer reached its length limit.", "warning");
        else if (turn.result.stopReason === "refusal")
          notice("The model declined to answer.", "warning");
        if (done.length > 0 && turn.result.stopReason === "end_turn") {
          push({ kind: "result", ...workResult(done, Date.now() - started) });
        }
      } catch (error) {
        flush();
        const message = describeError(error);
        notice(message, /^Cancel/.test(message) ? "warning" : "error");
      } finally {
        abort.current = undefined;
        setTools([]);
        setBusy(undefined);
        setTick((t) => t + 1);
        void readEnvironment(active.workspace.root).then(setEnvironment);
        void refreshUsage("turn");
        void refreshAutoUsage(true);
      }
    },
    [push, notice, refreshUsage, refreshAutoUsage],
  );

  const leave = useCallback(async () => {
    if (exiting.current) return;
    exiting.current = true;
    setMode("exiting");
    if (session && session.turns > 0) {
      notice("Saving where this session stands…");
      await runTurn(session, session.memory.endOfSession(), undefined, "Saving a checkpoint");
    }
    await session?.close();
    exit();
  }, [session, runTurn, notice, exit]);

  /** An orchestrator wired to this screen: its questions in the permission box, its changes in the run view. */
  const openOrchestrator = useCallback(
    async (pool = false, pinned?: Provider): Promise<Orchestrator> => {
      return services.orchestrator(
        {
          // A named provider (not Auto): its sub-agents use it alone.
          ...(pinned ? { provider: pinned, providers: [pinned], auto: false } : {}),
          // The person's permissions for sub-agents; unattended, the run goes on alone.
          permissions: session?.subagentPermissions ?? settingsPermissionMode(),
          ...(session?.unattended ? { mode: "extended" as const } : {}),
          onActivity: (activity) => {
            setAgents((current) => withActivity(current, activity));
          },
          // What sub-agents tell the orchestrator, and its answers to their requests.
          onNote: (note) => {
            if (note.kind === "progress") {
              setAgents((current) =>
                withReport(current, note.runId, note.task, note.report.summary),
              );
              notice(`${note.task} → orchestrator: ${note.report.summary}`, "info");
              return;
            }
            const { request, decision } = note;
            const asked =
              request.kind === "rerun"
                ? `a rerun of ${request.task ?? request.from}`
                : `a new task (${request.what.split("\n", 1)[0] ?? ""})`;
            notice(
              `${request.from} asks for ${asked}: ${request.reason}. ${decision.accept ? `Accepted as ${decision.added?.id ?? "?"}` : "Rejected"}: ${decision.reason}`,
              decision.accept ? "success" : "warning",
            );
            const orchestrator = orchestration.current?.orchestrator;
            if (decision.accept && orchestrator) {
              const tasks = orchestrator.store.tasks(request.runId).map((t) => ({
                id: t.id,
                title: t.spec.title,
                state: t.state,
              }));
              setAgents((current) =>
                withTasks(current, request.runId, tasks, (id) =>
                  orchestrator.taskWhere(request.runId, id),
                ),
              );
              setWatched((current) =>
                current && current.runId === request.runId ? { ...current, tasks } : current,
              );
            }
          },
          // The run's work reaching the person's folder, task by task and at the end.
          onDelivered: ({ lines }) => {
            for (const line of lines) {
              const text = line.trim();
              if (text !== "")
                notice(text, /not brought|Not merged|failed/.test(text) ? "warning" : "success");
            }
          },
          ask: (question) =>
            new Promise<boolean>((resolve) => {
              setApproval({
                what: `${question.action}${question.worker ? ` (${question.worker})` : ""}`,
                reason: question.reason,
                resolve,
              });
            }),
          onChange: (change) => {
            const run = runNow.current;
            if (run && change.type === "task") {
              setAgents((current) =>
                withState(current, run, change.task, change.state, change.reason),
              );
            }
            setWatched((current) => {
              if (!current) return current;
              if (change.type === "run") return { ...current, state: change.state };
              return {
                ...current,
                tasks: current.tasks.map((t) =>
                  t.id === change.task
                    ? {
                        ...t,
                        state: change.state,
                        ...(change.reason ? { reason: change.reason } : {}),
                      }
                    : t,
                ),
              };
            });
          },
          onWorkers: (active) => {
            setWatched((current) => (current ? { ...current, workers: active } : current));
            const run = runNow.current;
            if (run) setAgents((current) => withWorkers(current, run, active));
          },
        },
        pool,
      );
    },
    [services, session],
  );

  /** Runs (or resumes) a run, watching it, and reports how it ended. */
  const driveRun = useCallback(
    async (
      orchestrator: Orchestrator,
      runId: string,
      options: { readonly forAgent?: boolean } = {},
    ): Promise<{ state: string; lines: string[]; delivered: boolean }> => {
      const tasks = orchestrator.store.tasks(runId).map((t) => ({
        id: t.id,
        title: t.spec.title,
        state: t.state,
        ...(t.reason ? { reason: t.reason } : {}),
      }));
      setWatched({ runId, state: "running", tasks, workers: [] });
      notice(orchestrator.describeWork(runId), "info");
      runNow.current = runId;
      setAgents((current) =>
        withTasks(current, runId, tasks, (id) => orchestrator.taskWhere(runId, id)),
      );
      orchestration.current = { orchestrator, running: true };
      // For the main agent's own call, its turn keeps the busy line.
      if (!options.forAgent) setBusy("Running the plan");
      let lines: string[];
      let state = "failed";
      let delivered = false;
      try {
        state = await orchestrator.run(runId);
        // The details (attempts, tokens, models, what the sub-agents asked), folded.
        const details = describeReport(orchestrator.report(runId));
        const told = orchestrator.coordination(runId);
        if (told.length > 0) details.push("", "What the sub-agents reported and asked:", ...told);
        // The result first: what was done, task by task.
        const result = describeResult(
          orchestrator.store.tasks(runId),
          orchestrator.store.events(runId),
          state,
        );
        lines = [result.headline, "", ...result.tasks];
        const delivery = orchestrator.delivery(runId)?.status;
        delivered = delivery === "merged" || delivery === "already";
        if (state === "completed") {
          const branch = orchestrator.integrationBranch(runId);
          if (delivered) {
            lines.push("", `The work is in your folder: merged into your branch from ${branch}.`);
          } else {
            lines.push(
              "",
              `The work is on ${branch}. Look at it, then merge it when you are ready:`,
            );
            lines.push(`  git diff HEAD...${branch}`, `  git merge ${branch}`);
          }
        } else if (state === "paused" || state === "waiting") {
          lines.push("", `The run is ${state}: /runs takes it up again.`);
        }
        push({
          kind: "block",
          title: "Result",
          lines,
          tone: result.ok ? "success" : "warning",
        });
        push({ kind: "block", title: "Run details", lines: details, foldable: true });
        // For the agent's own report: the result, then the details.
        lines = [...lines, "", ...details];
      } catch (error) {
        const message = `The run stopped: ${error instanceof Error ? error.message : String(error)}`;
        lines = [message];
        notice(message, "error");
      } finally {
        if (!options.forAgent) setBusy(undefined);
        setWatched(undefined);
        runNow.current = undefined;
        orchestration.current = undefined;
        orchestrator.close();
      }
      return { state, lines, delivered };
    },
    [push, notice],
  );

  /** Starts the plan on screen and watches it: after "Run it", or at once when unattended. */
  const startPlanned = useCallback(async () => {
    const current = orchestration.current;
    if (!current?.planned) return;
    const { run, uncommitted } = await current.orchestrator.start(
      current.request ?? "",
      current.planned,
    );
    if (uncommitted.length > 0) {
      notice(
        `${String(uncommitted.length)} changed files are not committed: the run starts from your last commit and does not see them.`,
        "warning",
      );
    }
    await driveRun(current.orchestrator, run.id);
  }, [notice, driveRun]);

  /**
   * The main agent's `delegate`: plans the request, shows the plan, and runs
   * it as sub-agents once the person says so; gives the agent the report.
   * In Auto they use every ready provider; otherwise the chat's provider.
   */
  useEffect(() => {
    launch.current = async (request, signal) => {
      if (orchestration.current) return "A run is already going on: wait for it to end.";
      if (auto && autoIds.length === 0) {
        return "Auto includes no provider yet, so no sub-agents can start. Tell the person to choose Auto's providers in /connect (space marks one), or do the work yourself.";
      }
      const orchestrator = await openOrchestrator(auto, auto ? undefined : provider);
      let planned: Awaited<ReturnType<Orchestrator["plan"]>>;
      try {
        planned = await orchestrator.plan(request, signal);
      } catch (error) {
        orchestrator.close();
        return `No plan could be made: ${error instanceof Error ? error.message : String(error)}`;
      }
      orchestration.current = { orchestrator, request, planned, running: false };
      push({ kind: "block", title: "Plan for sub-agents", lines: describePlan(planned) });
      const run = session?.unattended
        ? (notice("Unattended: the plan runs without asking.", "info"), true)
        : await new Promise<boolean>((resolve) => {
            pendingPlan.current = resolve;
            setMode("plan");
            signal.addEventListener("abort", () => {
              resolve(false);
            });
          });
      pendingPlan.current = undefined;
      setMode((current) => (current === "plan" ? "chat" : current));
      if (!run || signal.aborted) {
        orchestrator.close();
        orchestration.current = undefined;
        return "The person chose not to run this plan. Ask them what to change, or do the work yourself.";
      }
      const { run: started, uncommitted } = await orchestrator.start(request, planned);
      const stop = () => {
        orchestrator.cancel();
      };
      signal.addEventListener("abort", stop);
      try {
        const done = await driveRun(orchestrator, started.id, { forAgent: true });
        const branch = orchestrator.integrationBranch(started.id);
        return [
          `The sub-agents' run ended: ${done.state}.`,
          ...(uncommitted.length > 0
            ? [
                `${String(uncommitted.length)} files the person changed were not committed, so the run did not see them.`,
              ]
            : []),
          ...done.lines,
          "",
          done.delivered
            ? `Their work is in the person's folder: merged into their branch from ${branch}, and checked there.`
            : `Their work is on the branch ${branch}; it is not in the person's folder yet (git merge ${branch}).`,
        ].join("\n");
      } finally {
        signal.removeEventListener("abort", stop);
      }
    };
  }, [auto, autoIds, provider, openOrchestrator, driveRun, push, notice, session]);

  /** What a line typed in the box does. */
  const submit = useCallback(
    async (line: string) => {
      const text = line.trim();
      if (text === "") return;
      setSent((current) => [...current.filter((s) => s !== text), text].slice(-100));
      const command = parseCommand(text);

      /** Plans a request and shows the plan to run; `pool`: across every ready provider. */
      const plan = async (request: string, pool: boolean) => {
        setBusy("Planning");
        try {
          const orchestrator = await openOrchestrator(pool);
          const planned = await orchestrator.plan(request);
          orchestration.current = { orchestrator, request, planned, running: false };
          push({ kind: "block", title: "Plan", lines: describePlan(planned) });
          if (session?.unattended) {
            notice("Unattended: the plan runs without asking.", "info");
            void startPlanned();
          } else {
            setMode("plan");
          }
        } catch (error) {
          notice(`No plan: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          setBusy(undefined);
        }
      };

      if (!command) {
        if (!session) {
          notice(
            "Not connected yet: /palace sets up the memory, /connect the provider.",
            "warning",
          );
          return;
        }
        if (!auto && isNoModel(session.provider)) {
          notice(NO_MODEL_TEXT, "warning");
          return;
        }
        if (auto && autoIds.length === 0) {
          // Auto with nothing in it: said, and the chat answers with its own provider.
          notice(
            `Auto includes no provider yet: /connect, then space on the ones it may use. Answering with ${session.provider.name} meanwhile.`,
            "warning",
          );
          await runTurn(session, text, text);
          return;
        }
        if (auto) {
          // A light model decides: answer directly, or orchestrate.
          setBusy("Deciding how to answer");
          const decision = await services.triage(text).finally(() => {
            setBusy(undefined);
          });
          const by = decision.by ? ` · ${decision.by}` : "";
          if (decision.route === "orchestrate") {
            notice(`Auto: a plan across providers (${decision.reason})${by}`, "info");
            await plan(text, true);
            return;
          }
          notice(`Auto: answering directly (${decision.reason})${by}`, "info");
          // Directly, on the provider with the most room when the current one has little.
          const members = await services.pool();
          const current = members.find((m) => m.provider.id === session.provider.id);
          const used = Math.max(0, ...(current?.usage?.limits.map((l) => l.used) ?? [0]));
          const best = mostRoom(members);
          if (best && best.provider.id !== session.provider.id && (!current || used >= 0.8)) {
            await session.setProvider(best.provider);
            setModels([]);
            setUsage(undefined);
            notice(
              `Auto: the chat goes on with ${best.provider.name}, which has more room.`,
              "info",
            );
          }
        }
        await runTurn(session, text, text);
        return;
      }
      if (!command.known) {
        notice(`Unknown command /${command.name}. /help lists them.`, "error");
        return;
      }
      const free = [
        "help",
        "projects",
        "connect",
        "palace",
        "clear",
        "exit",
        "status",
        "sidebar",
        "agents",
        "skills",
      ];
      if (!free.includes(command.name) && !session) {
        notice("Not connected yet: /palace sets up the memory.", "warning");
        return;
      }
      const active = session as AgentSession;
      switch (command.name) {
        case "help":
          push({ kind: "block", title: "Commands", lines: helpLines() });
          break;
        case "new":
          await active.newConversation();
          setItems([]);
          notice(
            "New conversation. The earlier one is kept: /resume takes it up again.",
            "success",
          );
          break;
        case "resume": {
          const list = active.conversations().filter((c) => c.id !== active.conversation.id);
          if (list.length === 0) {
            notice("No earlier conversations of this project yet.");
            break;
          }
          // Rows to resume or delete: the open conversation is never among them.
          setResumable(
            list.map((c) => ({
              id: c.id,
              label: c.title,
              hint: `${ago(c.updated)} · ${String(c.messages)} message${c.messages === 1 ? "" : "s"}`,
            })),
          );
          setMode("resume");
          break;
        }
        case "models":
          if (models.length === 0 && provider) setModels(await provider.models());
          setMode("models");
          break;
        case "sandbox": {
          const { sandboxCommand } = await import("../app/sandbox-command.js");
          const { sandboxManager } = await import("../sandbox/manager.js");
          const said = await sandboxCommand(
            command.args.trim().split(/\s+/).filter(Boolean),
            sandboxManager(),
            { cwd: session?.workspace.root ?? process.cwd() },
          );
          push({ kind: "block", title: said.title, lines: said.lines });
          break;
        }
        case "leader": {
          // A model of one of the providers in Auto: the runs' sub-agents come from them.
          const members = services.providers.filter((p) => autoIds.includes(p.id));
          if (members.length === 0) {
            notice(
              "Auto includes no provider yet: mark them in /connect (space), then choose a leader among their models.",
              "warning",
            );
            break;
          }
          setBusy("Asking for the models");
          try {
            const lists = await Promise.all(
              members.map(async (p) => ({
                provider: p,
                models: await p.models().catch(() => []),
              })),
            );
            const now = process.env.AGENT_LEADER?.trim() ?? "";
            setLeaderItems([
              {
                id: "",
                label: "No leader",
                hint: "the router chooses who plans; checks and the optional review decide",
                current: now === "",
              },
              ...lists.flatMap(({ provider: p, models: found }) => [
                {
                  id: p.id,
                  label: `${p.name} · its own choice of model`,
                  hint: p.id,
                  current: now === p.id,
                },
                ...found
                  .filter((m) => m.id !== "default")
                  .map((m) => ({
                    id: `${p.id}/${m.id}`,
                    label: `${p.name} · ${m.name}`,
                    hint: [m.id !== m.name ? m.id : "", m.hint ?? ""].filter(Boolean).join(" · "),
                    current: now === `${p.id}/${m.id}`,
                  })),
              ]),
            ]);
          } finally {
            setBusy(undefined);
          }
          setMode("leader");
          break;
        }
        case "effort":
          setMode("effort");
          break;
        case "mode": {
          const word = command.args.trim().toLowerCase();
          if (word === "auto") enableAuto();
          else if (word === "specific" || word === "manual") enableSpecific();
          else if (word !== "") notice("/mode takes: auto, specific.", "warning");
          else setMode("mode");
          break;
        }
        case "connect": {
          const section = sectionOf(command.args);
          if (section === undefined) {
            notice(
              "/connect takes: cli, api, plans, local, list, status, manage, disconnect <connection>.",
              "warning",
            );
            break;
          }
          if (section === "list" || section === "status") {
            void showConnections(section === "status");
            break;
          }
          if (section === "disconnect") {
            const id = command.args.trim().split(/\s+/)[1];
            const target = id
              ? services.providers.find(
                  (p) => p.id === id || PROVIDER_PROFILES[p.id]?.shownAs === id,
                )
              : undefined;
            if (!target || !services.connections) {
              notice(
                "Say which: /connect disconnect <connection> (as /connect list names it).",
                "warning",
              );
              break;
            }
            void services.connections.disconnect(target.id).then((said) => {
              notice(said, "success");
            });
            break;
          }
          setConnectView(
            section === "menu"
              ? { kind: "menu" }
              : section === "manage"
                ? { kind: "manage" }
                : section === "local"
                  ? { kind: "local" }
                  : { kind: "section", type: section },
          );
          setMode("connect");
          break;
        }
        case "palace":
          setMode("palace");
          break;
        case "projects":
          setMode("projects");
          break;
        case "permissions":
          setPermissionChoice(undefined);
          setMode("permissions");
          break;
        case "unattended": {
          const on =
            command.args === "on" ? true : command.args === "off" ? false : !active.unattended;
          active.setUnattended(on);
          setTick((t) => t + 1);
          notice(
            on
              ? "Unattended: the session and its sub-agents go on alone until the task is done. Tools run without asking (what is never allowed stays so), plans run without being confirmed, runs merge when their checks pass. /unattended off ends it."
              : `Unattended is off: permissions are ${PERMISSION_LABELS[active.permissionMode]} again.`,
            on ? "warning" : "success",
          );
          break;
        }
        case "usage": {
          // A reading of the last minute is shown at once; "/usage refresh" asks anew.
          const ask = { fresh: command.args === "refresh" };
          setBusy("Asking the provider");
          let fresh = usage;
          // The other providers a run may use (AGENT_PROVIDERS), each with its own plan.
          let others: { name: string; usage: ProviderUsage | undefined }[];
          try {
            const chosen = providerIds(process.env.AGENT_PROVIDERS);
            const [mine, theirs] = await Promise.all([
              provider ? provider.usage(ask) : Promise.resolve(undefined),
              Promise.all(
                services.providers
                  .slice(1)
                  // Local servers have no quota to show.
                  .filter((other) => chosen.includes(other.id) && !isLocalProvider(other.id))
                  .map(async (other) => ({
                    name: other.name,
                    usage: await other.usage(ask).catch(() => undefined),
                  })),
              ),
            ]);
            if (provider) {
              usageAt.current = Date.now();
              fresh = mine ?? usage;
              if (fresh) setUsage(fresh);
              setUsageStale(mine === undefined);
            }
            others = theirs;
          } finally {
            setBusy(undefined);
          }
          push({
            kind: "block",
            title: "Usage",
            lines: [
              ...usageLines(active, fresh, provider?.name),
              ...others.flatMap((o) => ["", ...limitLines(o.usage, o.name)]),
            ],
          });
          break;
        }
        case "mcp": {
          const servers = active.extensions?.mcp ?? [];
          const grafeno = active.grafenoMcp;
          push({
            kind: "block",
            title: "MCP servers",
            lines: [
              `  ${"grafeno".padEnd(20)} ${String(grafeno.tools.length)} tool${grafeno.tools.length === 1 ? "" : "s"} · built in · always on`,
              `  ${" ".repeat(20)} the agent's memory (namespace ${grafeno.namespace}): it cannot be turned off, the agent works through it`,
              ...(servers.length === 0
                ? ["", "No external MCP servers yet."]
                : servers.map(
                    (m) =>
                      `  ${m.name.padEnd(20)} ${m.error ? `not reached: ${m.error}` : `${String(m.tools)} tool${m.tools === 1 ? "" : "s"}`}`,
                  )),
              "",
              "Add one: grafeno-agent mcp add <name> -- <command> [args] · or --url <url>",
              "Their tools ask you before they change anything, unless the server marks them read-only.",
              "Changes reach the agent from its next session.",
            ],
          });
          break;
        }
        case "plugins": {
          const plugins = active.extensions?.plugins ?? [];
          push({
            kind: "block",
            title: "Plugins",
            lines: [
              ...(plugins.length === 0
                ? ["No plugin is on. Plugins: GitHub, GitLab."]
                : plugins.map(
                    (p) =>
                      `  ${p.name.padEnd(10)} ${p.status.ready ? `✓ ${String(p.tools)} tools · ${p.status.detail}` : `✗ ${p.status.detail}`}`,
                  )),
              "",
              "grafeno-agent plugins shows each one, how to connect it and its terms.",
              "Turn one on: grafeno-agent plugins enable github (it is checked first).",
              "Reading runs at once; opening, commenting or changing anything asks you first.",
              "Changes reach the agent from its next session.",
            ],
          });
          break;
        }
        case "skills": {
          const root = session?.workspace.root ?? process.cwd();
          push({
            kind: "block",
            title: "Skills",
            lines: [
              ...describeSkills(findSkills(skillRoots(root))),
              "",
              "The agent uses a skill when a task matches its description.",
              "Install: grafeno-agent skills add <owner/repo> (the Skills CLI) · yours: grafeno-agent skills new <name>",
              "New skills reach the agent from its next conversation (/new).",
            ],
          });
          break;
        }
        case "agents":
          if (agents.length === 0) {
            notice(
              "No sub-agents yet: the main agent starts them for work with parallel parts (or /orchestrate).",
            );
            break;
          }
          setMode("agents");
          break;
        case "status":
          push({
            kind: "block",
            title: "Status",
            lines: statusLines(session, services, status, models),
          });
          break;
        case "memory":
          push({
            kind: "block",
            title: "What memory brought back",
            lines: active.memory.brief.split("\n"),
          });
          break;
        case "checkpoint":
          await runTurn(active, active.memory.endOfSession(), "/checkpoint", "Saving a checkpoint");
          break;
        case "upkeep":
          setBusy("Looking after the memory");
          try {
            push({
              kind: "block",
              title: "Memory upkeep",
              lines: (await services.upkeep(active)).split("\n"),
            });
          } catch (error) {
            notice(
              `Upkeep failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          } finally {
            setBusy(undefined);
          }
          break;
        case "orchestrate": {
          if (command.args === "") {
            notice("Say what to build: /orchestrate build the orders API with tests", "warning");
            break;
          }
          await plan(command.args, auto);
          break;
        }
        case "runs": {
          try {
            const orchestrator = await openOrchestrator();
            const runs = orchestrator.runs();
            if (runs.length === 0) {
              notice("No runs in this project yet: /orchestrate starts one.");
              orchestrator.close();
              break;
            }
            orchestration.current = { orchestrator, running: false };
            setRunChoices(
              runs.map((run) => ({
                id: run.id,
                label: run.request.length > 60 ? `${run.request.slice(0, 59)}…` : run.request,
                hint: `${run.state} · ${ago(run.updated)}`,
              })),
            );
            setMode("runs");
          } catch (error) {
            notice(error instanceof Error ? error.message : String(error), "error");
          }
          break;
        }
        case "sidebar":
          setSidebarOn((on) => !on);
          break;
        case "clear":
          setItems([]);
          break;
        case "exit":
          await leave();
          break;
      }
    },
    [
      session,
      services,
      provider,
      models,
      usage,
      status,
      runTurn,
      push,
      notice,
      leave,
      openOrchestrator,
      startPlanned,
      auto,
      autoIds,
      agents,
    ],
  );

  /**
   * Answers the permission request on screen, by a key or a click. A request
   * that just appeared takes no answer for a moment: a key typed for a
   * message, or a click aimed at what was there before, is not an answer.
   */
  const answerApproval = (allowed: boolean) => {
    if (!approval || Date.now() - approvalShown.current < APPROVAL_GRACE_MS) return;
    approval.resolve(allowed);
    setApproval(undefined);
    notice(
      `${allowed ? "Allowed" : "Not allowed"}: ${approvalSummary(approval.what)}`,
      allowed ? "success" : "warning",
    );
  };

  // The wheel scrolls the conversation when no menu is open; an open menu scrolls itself.
  // What is typed in the conversation's prompt, kept while a menu is open over it.
  const draft = useRef("");
  const keepDraft = useCallback((text: string) => {
    draft.current = text;
  }, []);
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const onWheel = useCallback((direction: number) => {
    if (modeNow.current !== "chat") return;
    setScroll((s) => Math.max(0, s + direction * 3));
  }, []);
  // The conversation's layer: it scrolls only while nothing is open over it.
  useWheel(onWheel, "base");

  /**
   * An action, however it was reached: a menu button, its key, the palette
   * or a command typed with "/" (which goes through `submit` as typed).
   */
  const runAction = (id: string) => {
    if (id.startsWith("command.")) {
      const name = id.slice("command.".length);
      setPermissionChoice(undefined);
      if (mode !== "chat") setMode("chat");
      if (name !== "agents") setViewing(undefined);
      void submit(`/${name}`);
      return;
    }
    switch (id) {
      case "palette":
        setMode("palette");
        break;
      case "view.sidebar":
        setMode((m) => (m === "palette" ? "chat" : m));
        setSidebarOn((on) => !on);
        break;
      case "view.fold":
        setMode((m) => (m === "palette" ? "chat" : m));
        setAllOpen((open) => !open);
        setFlipped(new Set());
        break;
      case "agents.next": {
        setMode((m) => (m === "palette" ? "chat" : m));
        if (agents.length === 0) {
          notice("No sub-agent is working: the main agent is the only one.", "info");
          break;
        }
        // Through the main agent and its sub-agents, round.
        const keys = [undefined, ...agents.map(agentKey)];
        const at = keys.indexOf(viewing);
        setViewing(keys[(at + 1) % keys.length]);
        setScroll(0);
        break;
      }
    }
  };

  // An approval has the keys while it waits: nothing else hears them.
  useKeys(
    (input, key) => {
      if (input === "y" || input === "Y" || input === "s") answerApproval(true);
      else if (input === "n" || input === "N" || key.escape) answerApproval(false);
    },
    { layer: "modal", isActive: approval !== undefined },
  );

  useGlobalKeys((input, key, top) => {
    if (top === "modal" || approval) return;
    // A menu or dialog has the keys: only what works everywhere reaches here.
    const inMenu = top === "overlay" || (mode !== "chat" && mode !== "exiting");
    if (inMenu && !(key.ctrl && (input === "c" || input === "b"))) return;
    // Esc in a menu is the menu's own: each goes back one step (a section of
    // /connect to its menu, a step to the one before) and closes at its first.
    // Here it goes back to the main agent from a sub-agent, or stops work,
    // only from the conversation.
    if (key.escape && mode !== "chat" && mode !== "exiting") return;
    if (key.escape && viewed) {
      setViewing(undefined);
      setScroll(0);
      return;
    }
    if (key.escape && orchestration.current?.running) {
      orchestration.current.orchestrator.pause();
      notice("Pausing the run: what runs now finishes, nothing new starts.", "warning");
      return;
    }
    if (key.ctrl && input === "c" && orchestration.current?.running) {
      orchestration.current.orchestrator.cancel();
      notice("Cancelling the run.", "warning");
      return;
    }
    if (key.escape && busy !== undefined) {
      abort.current?.abort();
      return;
    }
    if (key.pageUp) setScroll((s) => s + Math.max(3, rows - 10));
    else if (key.pageDown) setScroll((s) => Math.max(0, s - Math.max(3, rows - 10)));
    else if (key.ctrl && input === "b") runAction("view.sidebar");
    else if (key.ctrl && input === "o") runAction("view.fold");
    else if (key.ctrl && input === "p") runAction("palette");
    else if (key.ctrl && input === "n") runAction("agents.next");
    else if (key.ctrl && input === "c") {
      if (busy !== undefined && abort.current) abort.current.abort();
      else if (mode === "exiting") exit();
      else if (mode !== "chat") setMode("chat");
      else void leave();
    }
  });

  const showSidebar = sidebarOn && columns >= SIDEBAR_FROM;
  // The agents panel: once a run started sub-agents, when the window has room for it.
  const showAgents = agents.length > 0 && columns >= (showSidebar ? AGENTS_FROM : 100);
  const viewed = viewing ? agents.find((a) => agentKey(a) === viewing) : undefined;
  const grafeno = services.grafeno();

  // The first run: memory, then the provider.
  if (phase === "setup-memory" || phase === "setup-provider") {
    return (
      <Box
        flexDirection="column"
        height={rows}
        width={columns}
        justifyContent="center"
        alignItems="center"
      >
        <Logo version={services.version} tagline="A programming assistant with long-term memory." />
        <Box marginTop={1} width={Math.min(84, columns - 4)} flexDirection="column">
          <Text bold>Welcome. Two things to set up, once:</Text>
          <Text dimColor>
            {phase === "setup-memory" ? "▸ 1. Memory" : "✓ 1. Memory"} ·{" "}
            {phase === "setup-provider" ? "▸ " : ""}2. Provider
          </Text>
          <Box marginTop={1} flexDirection="column">
            {phase === "setup-memory" ? (
              <PalacePanel
                services={services}
                firstRun
                onDone={(result) => {
                  if (result) notice(result.message, "success");
                  setPhase("setup-provider");
                }}
              />
            ) : (
              <ProviderPanel
                providers={services.providers}
                firstRun
                onDone={(found) => {
                  if (found) setStatus(found);
                  void connect();
                }}
              />
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  /** /mode → Auto: each message triaged, answered directly or planned across Auto's providers. */
  const enableAuto = () => {
    setMode("chat");
    if (!session) return;
    if (autoIds.length === 0) {
      notice(
        "Auto includes no provider yet: in /connect, mark the ones it may use with space, then choose Auto in /mode.",
        "warning",
      );
      return;
    }
    setAuto(true);
    services.saveChoice({ mode: "auto" });
    void services.pool().then(async (members) => {
      const best = mostRoom(members);
      if (best && best.provider.id !== session.provider.id) {
        await session.setProvider(best.provider);
        setModels([]);
        setUsage(undefined);
      }
      notice(
        `General Auto: each message is triaged by a light model, answered directly or planned across ${String(members.length)} ready provider${members.length === 1 ? "" : "s"}.`,
        "success",
      );
      setTick((t) => t + 1);
    });
  };

  /** /mode → specific: the provider chosen in /connect again (or no model, said as such). */
  const enableSpecific = () => {
    setMode("chat");
    setAuto(false);
    services.saveChoice({ mode: "specific" });
    if (!session) return;
    const next = chatProvider(services.providers, { ...process.env, AGENT_MODE: "specific" });
    void (async () => {
      if (next.id !== session.provider.id) {
        await session.setProvider(next);
        setModels([]);
        setUsage(undefined);
      }
      if (isNoModel(next)) notice((await next.status()).detail, "warning");
      else notice(`Specific: the chat uses ${next.name}. General Auto is off.`, "success");
      setTick((t) => t + 1);
    })();
  };

  /** Makes a provider the chat's (from /connect): said when it cannot be, and why. */
  const chooseProvider = (found: ProviderStatus, chosen: Provider) => {
    const ready = found.installed && found.signedIn;
    if (ready && auto) {
      // A named provider: General Auto ends.
      setAuto(false);
      if (session && chosen.id === session.provider.id) {
        services.saveChoice({ provider: chosen.id });
        notice(`Provider: ${chosen.name}. General Auto is off.`, "success");
        return;
      }
    }
    if (!ready || !session || chosen.id === session.provider.id) {
      if (chosen.id === provider?.id) setStatus(found);
      notice(`${chosen.name}: ${found.detail}`, ready ? "success" : "warning");
      return;
    }
    void session.setProvider(chosen).then(() => {
      services.saveChoice({ provider: chosen.id });
      setStatus(found);
      setModels([]);
      setUsage(undefined);
      notice(`Provider: ${chosen.name}, model Auto. The conversation goes on with it.`, "success");
      setTick((t) => t + 1);
    });
  };

  /** No model at all (from /connect): nothing connected is used until one is chosen. */
  const chooseNoModel = () => {
    setMode("chat");
    if (!session) return;
    setAuto(false);
    services.saveChoice({ provider: NO_MODEL });
    void session.setProvider(new NoModelProvider()).then(() => {
      setModels([]);
      setUsage(undefined);
      notice(NO_MODEL_TEXT, "warning");
      setTick((t) => t + 1);
    });
  };

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Header
        session={session}
        models={models}
        grafeno={grafeno.mode}
        busy={busy !== undefined}
        narrow={!showSidebar}
      />
      <MenuBar
        open={mode}
        busy={busy !== undefined || phase === "starting"}
        blocked={approval !== undefined}
        onCommand={(command, close) => {
          // The same menu again closes it; another one takes its place.
          if (close) {
            setMode("chat");
            return;
          }
          runAction(commandAction(command));
        }}
      />
      <Box flexDirection="row" flexGrow={1}>
        {showAgents && (
          <AgentsPanel
            width={AGENTS}
            main={{
              model: session ? modelLine(session, models) : "not connected",
              doing: busy ?? "waiting for you",
              busy: busy !== undefined,
            }}
            agents={agents}
            viewing={viewed ? viewing : undefined}
            onSelect={(key) => {
              setViewing(key);
              setScroll(0);
            }}
          />
        )}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {viewed ? (
            <Viewport scroll={scroll} onClamp={setScroll}>
              <AgentView agent={viewed} allOpen={allOpen} />
            </Viewport>
          ) : (
            <Viewport scroll={scroll} onClamp={setScroll}>
              {!items.some((i) => i.kind === "user" || i.kind === "assistant") && live === "" && (
                <Home
                  version={services.version}
                  ready={session !== undefined}
                  starting={phase === "starting"}
                  compact={rows < 34}
                />
              )}
              {groupItems(items).map((entry) =>
                "records" in entry ? (
                  <ActionGroup
                    key={entry.id}
                    records={entry.records}
                    open={allOpen !== flipped.has(entry.id)}
                    onToggle={() => {
                      setFlipped((current) => {
                        const next = new Set(current);
                        if (!next.delete(entry.id)) next.add(entry.id);
                        return next;
                      });
                    }}
                  />
                ) : (
                  <ItemView
                    key={entry.id}
                    item={entry}
                    open={allOpen !== flipped.has(entry.id)}
                    onToggle={() => {
                      setFlipped((current) => {
                        const next = new Set(current);
                        if (!next.delete(entry.id)) next.add(entry.id);
                        return next;
                      });
                    }}
                  />
                ),
              )}
              {live !== "" && (
                <Box marginTop={1} paddingLeft={2}>
                  <Markdown text={live} />
                </Box>
              )}
              {tools.map((tool) =>
                tool.action ? (
                  <ActionLine key={tool.id} action={tool.action} state="running" />
                ) : (
                  <Box key={tool.id} paddingLeft={2}>
                    <Spinner />
                    <Text color={theme.accent}> {tool.label}</Text>
                  </Box>
                ),
              )}
              {watched && (
                <RunView
                  runId={watched.runId}
                  state={watched.state}
                  tasks={watched.tasks}
                  workers={watched.workers}
                />
              )}
            </Viewport>
          )}
          {(busy !== undefined || phase === "starting") && (
            <Working
              label={phase === "starting" ? "Connecting to Grafeno" : (busy ?? "")}
              hint={busy !== undefined ? "esc to interrupt" : ""}
            />
          )}
          {scroll > 0 && <Text dimColor> ↓ {String(scroll)} lines below · pgdn</Text>}
          <Box flexDirection="column" flexShrink={0}>
            {approval && (
              <ApprovalBox
                approval={approval}
                waiting={approvals.length - 1}
                onAnswer={answerApproval}
              />
            )}
            {mode === "leader" && (
              <Picker
                title="Leader of orchestrated runs"
                search
                items={leaderItems}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  services.saveChoice({ leader: item.id });
                  process.env.AGENT_LEADER = item.id;
                  notice(
                    item.id === ""
                      ? "No leader: the router chooses who plans each run."
                      : `Leader: ${item.label}. It plans each run, gives the tasks to the sub-agents and audits every one: it approves it, or sends it back with what to fix.`,
                    "success",
                  );
                }}
              />
            )}
            {mode === "models" && session && (
              <Picker
                title="Model"
                items={(models.length > 0
                  ? models
                  : [{ id: session.model, name: modelName(session, models) }]
                ).map((m: ModelOption) => ({
                  id: m.id,
                  label: m.name,
                  ...(m.hint === undefined ? {} : { hint: m.hint }),
                  current: m.id === session.model,
                }))}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  void session.setModel(item.id).then(() => {
                    services.saveChoice({ model: item.id });
                    notice(`Model: ${item.label}. The conversation goes on with it.`, "success");
                    setTick((t) => t + 1);
                  });
                }}
              />
            )}
            {mode === "projects" && (
              <ProjectsPanel
                current={session?.workspace.root ?? process.cwd()}
                onDelete={async (project) =>
                  describeDeletion(await deleteProjectEverywhere(project.name))
                }
                footprint={(project) =>
                  projectFootprint(project, { sessionsDir: sessionsDir(), dataDir: dataDir() })
                }
                onDone={(project, message) => {
                  setMode("chat");
                  if (message) notice(message, "success");
                  if (!project) return;
                  if (session && project.path === session.workspace.root) {
                    notice(`${project.name} is the project already open.`, "info");
                    return;
                  }
                  // A new session in the project's folder: its conversations, runs and memory.
                  void (async () => {
                    await session?.close().catch(() => undefined);
                    process.chdir(project.path);
                    setSession(undefined);
                    setAgents([]);
                    setViewing(undefined);
                    notice(`Opening ${project.name} (${project.path})…`, "info");
                    setPhase("starting");
                  })();
                }}
              />
            )}
            {mode === "permissions" && session && permissionChoice === undefined && (
              <Picker
                title={`Permissions · now ${PERMISSION_LABELS[session.permissionMode]} (${SCOPE_LABELS[session.permissionScope]})${session.unattended ? " · unattended" : ""}`}
                items={[
                  {
                    id: "ask",
                    label: PERMISSION_LABELS.ask,
                    hint: "asks you before anything that changes something",
                    current: session.permissionMode === "ask",
                  },
                  {
                    id: "auto",
                    label: PERMISSION_LABELS.auto,
                    hint: "the agent decides: project changes run, deleting, pushing, installing or reaching outside asks",
                    current: session.permissionMode === "auto",
                  },
                  {
                    id: "skip",
                    label: PERMISSION_LABELS.skip,
                    hint: "runs everything without asking (what is never allowed stays so)",
                    current: session.permissionMode === "skip",
                  },
                ]}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setPermissionChoice(item.id as PermissionMode);
                }}
              />
            )}
            {mode === "permissions" && session && permissionChoice !== undefined && (
              <Picker
                title={`${PERMISSION_LABELS[permissionChoice]} · for what?`}
                items={[
                  {
                    id: "agent",
                    label: SCOPE_LABELS.agent,
                    hint: "every session and sub-agent, from now on (saved in the settings)",
                  },
                  {
                    id: "session",
                    label: SCOPE_LABELS.session,
                    hint: "only this conversation, until it ends",
                  },
                  {
                    id: "session+subagents",
                    label: SCOPE_LABELS["session+subagents"],
                    hint: "this conversation and the sub-agents it starts",
                  },
                ]}
                onCancel={() => {
                  setPermissionChoice(undefined);
                }}
                onSelect={(item) => {
                  const chosen = permissionChoice;
                  const scope = item.id as PermissionScope;
                  setMode("chat");
                  setPermissionChoice(undefined);
                  if (session.unattended) session.setUnattended(false);
                  if (scope === "agent") {
                    services.saveChoice({ permissions: chosen });
                    session.setPermissions(undefined);
                  } else {
                    session.setPermissions(chosen, scope === "session+subagents");
                  }
                  setTick((t) => t + 1);
                  notice(
                    `Permissions: ${PERMISSION_LABELS[chosen]}, ${SCOPE_LABELS[scope].toLowerCase()}.${chosen === "skip" ? " Everything runs without asking, except what is never allowed." : ""}`,
                    chosen === "skip" ? "warning" : "success",
                  );
                }}
              />
            )}
            {mode === "palette" && (
              <Picker
                title="Commands"
                search
                rows={12}
                items={paletteItems([...VIEW_ACTIONS, ...commandActions(COMMANDS)])}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  runAction(item.id);
                }}
              />
            )}
            {mode === "mode" && (
              <Picker
                title="Mode"
                items={[
                  {
                    id: "auto",
                    label: "Auto",
                    hint:
                      autoIds.length === 0
                        ? "includes no provider yet: mark them in /connect with space"
                        : `each message triaged, answered directly or planned across ${autoIds.join(", ")}`,
                    current: auto,
                  },
                  {
                    id: "specific",
                    label: `Specific · ${
                      session && !auto
                        ? session.provider.name
                        : chatProvider(services.providers, {
                            ...process.env,
                            AGENT_MODE: "specific",
                          }).name
                    }`,
                    hint: "the provider chosen in /connect (choosing one there switches to it)",
                    current: !auto,
                  },
                ]}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  if (item.id === "auto") enableAuto();
                  else enableSpecific();
                }}
              />
            )}
            {mode === "effort" && session && (
              <Picker
                title={`Effort · ${modelName(session, models)}`}
                items={[
                  {
                    id: "default",
                    label: "Default",
                    hint: "the model's own",
                    current: session.effort === undefined,
                  },
                  ...session.provider.efforts(session.model).map((e) => ({
                    id: e,
                    label: effortLabel(e) ?? e,
                    current: e === session.effort,
                  })),
                ]}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  void session.setEffort(item.id).then(() => {
                    services.saveChoice({ effort: item.id });
                    notice(`Effort: ${item.label}. The conversation goes on with it.`, "success");
                    setTick((t) => t + 1);
                  });
                }}
              />
            )}
            {mode === "plan" && orchestration.current?.planned && (
              <Picker
                title="Run this plan?"
                items={[
                  {
                    id: "run",
                    label: "Run it",
                    hint: `${orchestration.current.orchestrator.policy.mode} · each task in its own worktree`,
                  },
                  { id: "cancel", label: "Not now" },
                ]}
                onCancel={() => {
                  if (pendingPlan.current) {
                    pendingPlan.current(false);
                    return;
                  }
                  orchestration.current?.orchestrator.close();
                  orchestration.current = undefined;
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  // The main agent's own plan: it starts the run and reads the report.
                  if (pendingPlan.current) {
                    pendingPlan.current(item.id === "run");
                    return;
                  }
                  const current = orchestration.current;
                  if (!current?.planned || item.id !== "run") {
                    current?.orchestrator.close();
                    orchestration.current = undefined;
                    return;
                  }
                  void startPlanned();
                }}
              />
            )}
            {mode === "runs" && orchestration.current && (
              <Picker
                title="Runs of this project"
                items={runChoices}
                onCancel={() => {
                  orchestration.current?.orchestrator.close();
                  orchestration.current = undefined;
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  const current = orchestration.current;
                  if (!current) return;
                  const run = current.orchestrator.store.run(item.id);
                  if (run && (run.state === "completed" || run.state === "cancelled")) {
                    push({
                      kind: "block",
                      title: "Run report",
                      lines: describeReport(current.orchestrator.report(item.id)),
                    });
                    current.orchestrator.close();
                    orchestration.current = undefined;
                    return;
                  }
                  void driveRun(current.orchestrator, item.id);
                }}
              />
            )}
            {mode === "resume" && session && (
              <SessionsPanel
                sessions={resumable.map((r) => ({ id: r.id, title: r.label, hint: r.hint ?? "" }))}
                onCancel={() => {
                  setMode("chat");
                }}
                onDelete={(row) => {
                  if (session.deleteConversation(row.id)) {
                    setResumable((current) => current.filter((r) => r.id !== row.id));
                    notice(`Deleted the conversation “${row.title}”.`, "success");
                  } else {
                    notice("That conversation could not be deleted.", "error");
                  }
                }}
                onResume={(id) => {
                  setMode("chat");
                  void session.resume(id).then((saved) => {
                    if (!saved) {
                      notice("That conversation could not be read.", "error");
                      return;
                    }
                    setItems([]);
                    push(...replay(saved.entries));
                    notice(`Resumed: ${saved.title}`, "success");
                  });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "menu" && (
              <ConnectMenu
                onCancel={() => {
                  setMode("chat");
                }}
                onSection={(section) => {
                  if (section === "list") {
                    setMode("chat");
                    void showConnections(false);
                  } else if (section === "manage") setConnectView({ kind: "manage" });
                  else if (section === "local") setConnectView({ kind: "local" });
                  else if (section !== "menu") setConnectView({ kind: "section", type: section });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "local" && services.connections && (
              <LocalPanel
                actions={services.connections}
                onUse={() => {
                  setConnectView({ kind: "section", type: "local", back: "local" });
                }}
                onUseConnection={(id) => {
                  const chosen = services.providers.find((p) => p.id === id);
                  if (!chosen) {
                    notice(
                      `${id} is not registered as a provider yet: try again in a moment.`,
                      "warning",
                    );
                    return;
                  }
                  void chosen.status().then((found) => {
                    setMode("chat");
                    chooseProvider(found, chosen);
                  });
                }}
                onCancel={() => {
                  setConnectView({ kind: "menu" });
                }}
                onDone={(message, tone) => {
                  setConnectView({ kind: "local" });
                  if (message) notice(message, tone ?? "success");
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "local" && !services.connections && (
              <Text color={theme.warning}>
                Local connections are set up from the terminal here.
              </Text>
            )}
            {mode === "connect" && connectView.kind === "key" && (
              <KeyEntry
                name={connectView.provider.name}
                hint={apiKeySpec(connectView.provider.id)?.signIn ?? connectView.provider.signIn}
                onSubmit={async (key) => {
                  if (!services.connections)
                    return { ok: false, message: "Keys are set from the terminal here." };
                  const result = await services.connections.setKey(connectView.provider.id, key);
                  return result;
                }}
                onCancel={() => {
                  const target = connectView.provider;
                  void target.status().then((found) => {
                    const spec = apiKeySpec(target.id);
                    if (
                      found.signedIn &&
                      spec?.kind === "api-key" &&
                      found.billing?.kind === "metered" &&
                      !(process.env.AGENT_ALLOW_BILLING ?? "")
                        .split(",")
                        .map((x) => x.trim())
                        .includes(target.id)
                    ) {
                      setConnectView({ kind: "billing", provider: target });
                    } else if (
                      found.signedIn &&
                      spec?.kind === "coding-plan" &&
                      !providerEnabled(target.id)
                    ) {
                      setConnectView({ kind: "plan", provider: target });
                    } else {
                      setConnectView({ kind: "section", type: connectView.back });
                    }
                  });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "billing" && (
              <Picker
                title={`${connectView.provider.name} bills per token: allow the agent to use it?`}
                items={[
                  {
                    id: "no",
                    label: "No, keep it unused",
                    hint: "nothing is billed; it stays connected",
                  },
                  {
                    id: "yes",
                    label: "Yes, allow per-token billing",
                    hint:
                      apiKeySpec(connectView.provider.id)?.pricing ?? "prices on the vendor's site",
                  },
                ]}
                onCancel={() => {
                  setConnectView({ kind: "section", type: "api-key" });
                }}
                onSelect={(item) => {
                  if (item.id === "yes" && services.connections) {
                    notice(
                      services.connections.setBilling(connectView.provider.id, true),
                      "warning",
                    );
                  }
                  setConnectView({ kind: "section", type: "api-key" });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "plan" && (
              <Picker
                title={`Switch on ${connectView.provider.name}? ${complianceText(PROVIDER_PROFILES[connectView.provider.id]?.compliance ?? "unverified")}`}
                items={[
                  { id: "no", label: "No, keep it off", hint: "the key is kept for later" },
                  {
                    id: "yes",
                    label: "Yes, at my own risk",
                    hint: "it can be switched off at any time",
                  },
                ]}
                onCancel={() => {
                  setConnectView({ kind: "section", type: "coding-plan" });
                }}
                onSelect={(item) => {
                  if (item.id === "yes" && services.connections) {
                    notice(
                      services.connections.setEnabled(connectView.provider.id, true),
                      "warning",
                    );
                  }
                  setConnectView({ kind: "section", type: "coding-plan" });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "manage" && (
              <Picker
                title="Manage connections"
                rows={12}
                items={services.providers.map((p) => ({
                  id: p.id,
                  label: `${PROVIDER_PROFILES[p.id]?.shownAs ?? p.id} · ${p.name}`,
                  hint: providerEnabled(p.id) ? "on" : "off",
                }))}
                onCancel={() => {
                  setConnectView({ kind: "menu" });
                }}
                onSelect={(item) => {
                  const chosen = services.providers.find((p) => p.id === item.id);
                  if (chosen) setConnectView({ kind: "actions", provider: chosen });
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "actions" && (
              <Picker
                title={connectView.provider.name}
                items={[
                  providerEnabled(connectView.provider.id)
                    ? { id: "off", label: "Switch off", hint: "at once: nothing uses it" }
                    : {
                        id: "on",
                        label: "Switch on",
                        hint:
                          PROVIDER_PROFILES[connectView.provider.id]?.compliance === "documented"
                            ? ""
                            : complianceText(
                                PROVIDER_PROFILES[connectView.provider.id]?.compliance ??
                                  "unverified",
                              ),
                      },
                  {
                    id: "check",
                    label: "Check now",
                    hint: "installed, signed in, ready (spends nothing)",
                  },
                  ...(apiKeySpec(connectView.provider.id)
                    ? [
                        {
                          id: "key",
                          label: "Set or change the key",
                          hint: "checked before it is kept",
                        },
                        {
                          id: "disconnect",
                          label: "Disconnect",
                          hint: "remove its key from the secure store",
                        },
                      ]
                    : []),
                  ...(apiKeySpec(connectView.provider.id)?.kind === "api-key"
                    ? (process.env.AGENT_ALLOW_BILLING ?? "")
                        .split(",")
                        .map((x) => x.trim())
                        .includes(connectView.provider.id)
                      ? [
                          {
                            id: "forbid",
                            label: "Forbid per-token billing",
                            hint: "it stays connected, unused",
                          },
                        ]
                      : [
                          {
                            id: "allow",
                            label: "Allow per-token billing",
                            hint: "only if you mean it",
                          },
                        ]
                    : []),
                  { id: "back", label: "Back" },
                ]}
                onCancel={() => {
                  setConnectView({ kind: "manage" });
                }}
                onSelect={(item) => {
                  const target = connectView.provider;
                  const actions = services.connections;
                  switch (item.id) {
                    case "on":
                    case "off":
                      if (actions)
                        notice(actions.setEnabled(target.id, item.id === "on"), "success");
                      if (item.id === "off" && session && session.provider.id === target.id) {
                        // Off means off, now: the chat leaves it, with no model until another is chosen.
                        void session
                          .setProvider(
                            new NoModelProvider(
                              `${target.name} is switched off, so no model is selected: nothing is sent to any provider. Choose another in /connect.`,
                            ),
                          )
                          .then(() => {
                            setModels([]);
                            setUsage(undefined);
                            notice(
                              `${target.name} was the chat's model: no model is selected now. Choose another in /connect.`,
                              "warning",
                            );
                            setTick((t) => t + 1);
                          });
                      }
                      setConnectView({ kind: "manage" });
                      break;
                    case "check":
                      void target.status().then((found) => {
                        const record = connectionRecord(target, found);
                        notice(
                          `${record.displayName}: ${stateOf(record)}. ${found.detail}`,
                          record.available ? "success" : "warning",
                        );
                      });
                      break;
                    case "key":
                      setConnectView({
                        kind: "key",
                        provider: target,
                        back: apiKeySpec(target.id)?.kind ?? "api-key",
                      });
                      break;
                    case "disconnect":
                      if (actions)
                        void actions.disconnect(target.id).then((said) => {
                          notice(said, "success");
                        });
                      setConnectView({ kind: "manage" });
                      break;
                    case "allow":
                    case "forbid":
                      if (actions)
                        notice(actions.setBilling(target.id, item.id === "allow"), "warning");
                      setConnectView({ kind: "manage" });
                      break;
                    default:
                      setConnectView({ kind: "manage" });
                  }
                }}
              />
            )}
            {mode === "connect" && connectView.kind === "section" && (
              <ProviderPanel
                title={
                  connectView.type === "cli"
                    ? "CLI / Subscription"
                    : connectView.type === "api-key"
                      ? "API Key"
                      : connectView.type === "local"
                        ? "Local models / Self-hosted"
                        : "Coding Plan"
                }
                providers={services.providers.filter(
                  (p) =>
                    (PROVIDER_PROFILES[p.id]?.connectionType ?? "api-key") === connectView.type,
                )}
                {...(provider && !auto ? { current: provider.id } : {})}
                auto={auto}
                autoMembers={autoIds}
                apiKeyProviders={API_KEY_PROVIDERS}
                autoModels={autoModelChoice}
                onAutoModels={(id, chosen) => {
                  const next = { ...autoModelChoice, [id]: chosen };
                  services.saveChoice({ autoModels: next });
                  setAutoModelChoice(next);
                  const name = services.providers.find((p) => p.id === id)?.name ?? id;
                  notice(
                    chosen.length === 0
                      ? `${name} in Auto: every model, chosen by the task and by what each spends.`
                      : `${name} in Auto: ${chosen.join(", ")}, as you chose them (the hardest tasks to the strongest, simple ones to the lightest).`,
                    "success",
                  );
                }}
                onToggleAuto={(id) => {
                  const next = autoIds.includes(id)
                    ? autoIds.filter((x) => x !== id)
                    : [...autoIds, id];
                  if (next.length === 0) {
                    notice("Auto needs at least one provider.", "warning");
                    return;
                  }
                  services.saveChoice({ autoProviders: next });
                  setAutoIds(next);
                  const name = services.providers.find((p) => p.id === id)?.name ?? id;
                  notice(
                    `${name} is ${next.includes(id) ? "now" : "no longer"} in Auto.${
                      next.includes(id) && API_KEY_PROVIDERS.includes(id)
                        ? " It uses an API key: billed per token unless it is a free tier, and never billed without AGENT_ALLOW_BILLING."
                        : ""
                    }`,
                    next.includes(id) && API_KEY_PROVIDERS.includes(id) ? "warning" : "success",
                  );
                }}
                onDone={(found, chosen) => {
                  if (
                    found &&
                    chosen &&
                    !found.signedIn &&
                    apiKeySpec(chosen.id) !== undefined &&
                    providerEnabled(chosen.id)
                  ) {
                    setConnectView({
                      kind: "key",
                      provider: chosen,
                      back: connectView.type,
                    });
                    return;
                  }
                  if (!chosen) {
                    // Esc: back to where the section was opened from.
                    setConnectView(
                      connectView.back === "local" ? { kind: "local" } : { kind: "menu" },
                    );
                    return;
                  }
                  setMode("chat");
                  if (!found) return;
                  chooseProvider(found, chosen);
                }}
                none={session !== undefined && isNoModel(session.provider) && !auto}
                onNone={chooseNoModel}
              />
            )}
            {mode === "palace" && (
              <PalacePanel
                services={services}
                onDone={(result) => {
                  setMode("chat");
                  if (!result) return;
                  notice(result.message, "success");
                  if (result.changed) {
                    void (async () => {
                      await session?.close();
                      setSession(undefined);
                      await connect();
                    })();
                  }
                }}
              />
            )}
            {mode === "agents" && (
              <Picker
                title="Agents"
                items={[
                  {
                    id: "main",
                    label: "Main",
                    hint: "the chat: the agent you talk to",
                    current: viewing === undefined,
                  },
                  ...agents.map((a) => ({
                    id: agentKey(a),
                    label: a.id,
                    hint: `${a.doing ?? a.state}${a.model ? ` · ${a.model}` : ""}`,
                    current: viewing === agentKey(a),
                  })),
                ]}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  setViewing(item.id === "main" ? undefined : item.id);
                  setScroll(0);
                }}
              />
            )}
            {mode === "chat" && !approval && viewed && (
              <Box borderStyle="round" borderColor={theme.brand} paddingX={1}>
                <Text wrap="truncate-end">
                  <Text inverse bold color={theme.brand}>
                    {` Viewing ${viewed.id} `}
                  </Text>
                  <Text dimColor>
                    {" "}
                    {String(agents.findIndex((a) => agentKey(a) === viewing) + 1)} of{" "}
                    {String(agents.length)} · read only: the main agent orchestrates it · ctrl+n
                    next · /agents
                  </Text>
                </Text>
              </Box>
            )}
            {mode === "chat" && !approval && !viewed && (
              <Prompt
                layer="base"
                active={phase !== "starting"}
                canSubmit={busy === undefined}
                onHeld={() => {
                  notice(
                    "The agent is still answering: what you typed stays here; enter sends it once it is done (esc stops it).",
                    "info",
                  );
                }}
                initial={draft.current}
                onChange={keepDraft}
                placeholder={
                  phase === "starting"
                    ? "Connecting…"
                    : busy !== undefined
                      ? "Working… type ahead, esc to interrupt"
                      : session
                        ? "Ask anything · / for commands"
                        : "Not connected · /palace · /connect"
                }
                history={sent}
                onSubmit={(text) => {
                  void submit(text);
                }}
              />
            )}
          </Box>
        </Box>
        {showSidebar && (
          <Sidebar
            width={SIDEBAR}
            session={session}
            grafeno={grafeno}
            status={status}
            usage={usage}
            usageStale={usageStale}
            models={models}
            environment={environment}
            recall={recall}
            {...(auto ? { autoUsage } : {})}
            local={provider ? isLocalProvider(provider.id) : false}
            {...(viewed ? { agent: viewed } : {})}
            {...(mode === "chat" && !approval && busy === undefined
              ? {
                  onCommand: (command: string) => {
                    void submit(`/${command}`);
                  },
                }
              : {})}
          />
        )}
      </Box>
      <Footer narrow={!showSidebar} session={session} models={models} usage={usage} />
    </Box>
  );
}

/** The conversation's window: it shows the end, and scrolls back with PgUp. */
function Viewport({
  scroll,
  onClamp,
  children,
}: {
  readonly scroll: number;
  readonly onClamp: (scroll: number) => void;
  readonly children: ReactNode;
}): ReactNode {
  const outer = useRef<DOMElement>(null);
  const inner = useRef<DOMElement>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!outer.current || !inner.current) return;
    const view = measureElement(outer.current).clientHeight;
    const content = measureElement(inner.current).height;
    const most = Math.max(0, content - view);
    if (scroll > most) onClamp(most);
    const next = Math.max(0, most - Math.min(scroll, most));
    if (next !== offset) setOffset(next);
  });
  return (
    <Box ref={outer} flexDirection="column" flexGrow={1} overflow="hidden" contentOffsetY={offset}>
      <Box ref={inner} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}

function Header({
  session,
  models,
  grafeno,
  busy,
  narrow,
}: {
  readonly session: AgentSession | undefined;
  readonly models: readonly ModelOption[];
  readonly grafeno: "included" | "external";
  readonly busy: boolean;
  readonly narrow: boolean;
}): ReactNode {
  return (
    <Box paddingX={1} justifyContent="space-between" flexShrink={0} gap={2}>
      <Box flexShrink={1} flexGrow={1} minWidth={10}>
        <Text wrap="truncate-end">
          <Glyph /> <Text bold>Grafeno Agent</Text>
          {session && <Text dimColor> · {session.memory.project.name}</Text>}
          {session && session.conversation.title !== "" && (
            <Text dimColor> · {session.conversation.title}</Text>
          )}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        {busy && <Spinner />}
        {session ? (
          <Text color={theme.brand}> {modelLine(session, models)}</Text>
        ) : (
          <Text dimColor> not connected</Text>
        )}
        {!narrow && (
          <Text dimColor> · {grafeno === "included" ? "Grafeno included" : "Grafeno server"}</Text>
        )}
      </Text>
    </Box>
  );
}

function Home({
  version,
  ready,
  starting,
  compact,
}: {
  readonly version: string;
  readonly ready: boolean;
  readonly starting: boolean;
  /** A short window: the mark in one line, not drawn whole. */
  readonly compact: boolean;
}): ReactNode {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={compact ? 1 : 2}>
      {compact ? (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Glyph />{" "}
            <Text bold color={theme.brand}>
              G R A F E N O
            </Text>{" "}
            <Text bold>Agent</Text>
            <Text dimColor> v{version}</Text>
          </Text>
          <Text dimColor>A programming assistant with long-term memory.</Text>
        </Box>
      ) : (
        <Logo version={version} tagline="A programming assistant with long-term memory." />
      )}
      <Box marginTop={compact ? 1 : 2} flexDirection="column">
        {ready ? (
          <>
            <Tip keys="/models" text="choose the model · /effort how hard it thinks" />
            <Tip keys="/resume" text="take up an earlier conversation" />
            <Tip keys="/usage" text="your plan's real usage" />
            <Tip keys="/help" text="every command and key" />
          </>
        ) : (
          <Text dimColor>
            {starting ? "Connecting…" : "/palace sets up the memory · /connect the provider"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function Tip({ keys, text }: { readonly keys: string; readonly text: string }): ReactNode {
  return (
    <Text>
      <Text color={theme.brand}>{keys.padEnd(9)}</Text>
      <Text dimColor>{text}</Text>
    </Text>
  );
}

function Footer({
  narrow,
  session,
  models,
  usage,
}: {
  readonly narrow: boolean;
  readonly session: AgentSession | undefined;
  readonly models: readonly ModelOption[];
  readonly usage: ProviderUsage | undefined;
}): ReactNode {
  const limit = usage?.limits[0];
  return (
    <Box paddingX={1} justifyContent="space-between" flexShrink={0} gap={2}>
      <Box flexShrink={1} minWidth={10}>
        <Text wrap="truncate-end">
          {session?.unattended ? (
            <Text inverse bold color={theme.warning}>
              {" UNATTENDED "}
            </Text>
          ) : session && session.permissionMode !== "ask" ? (
            <Text color={session.permissionMode === "skip" ? theme.warning : theme.accent}>
              {`permissions: ${PERMISSION_LABELS[session.permissionMode].toLowerCase()}`}
            </Text>
          ) : null}
          {session && (session.unattended || session.permissionMode !== "ask") ? " · " : ""}
          <Text dimColor>
            {narrow
              ? "/ commands · pgup/pgdn · esc stop"
              : "enter send · / commands · pgup/pgdn scroll · ctrl+o actions · ctrl+b panel · esc interrupt"}
          </Text>
        </Text>
      </Box>
      {narrow && session && (
        <Text wrap="truncate-start">
          <Text color={theme.brand}>{modelLine(session, models)}</Text>
          {limit && (
            <Text color={theme[usageTone(limit.used)]}>
              {" "}
              · {limit.label.toLowerCase()} {String(Math.round(limit.used * 100))}%
            </Text>
          )}
        </Text>
      )}
    </Box>
  );
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** The items with finished actions in a row gathered, each run as one group. */
function groupItems(items: readonly Item[]): (Item | { id: number; records: ActionRecord[] })[] {
  const out: (Item | { id: number; records: ActionRecord[] })[] = [];
  let group: { id: number; records: ActionRecord[] } | undefined;
  for (const item of items) {
    if (item.kind === "tool" && item.action) {
      const tool = item as ToolItem & { action: Action };
      const record: ActionRecord = {
        action: tool.action,
        failed: tool.failed,
        ...(tool.output !== undefined ? { output: tool.output } : {}),
      };
      if (group) group.records.push(record);
      else {
        group = { id: item.id, records: [record] };
        out.push(group);
      }
      continue;
    }
    // Memory lines between actions do not break a group.
    if (item.kind === "memory" && group) continue;
    group = undefined;
    out.push(item);
  }
  return out;
}

/** The line that closes a turn that did things: how long, and what. */
function workResult(done: readonly ActionRecord[], ms: number): { text: string; failed: boolean } {
  const seconds = Math.round(ms / 1000);
  const took =
    seconds < 60
      ? `${String(Math.max(1, seconds))}s`
      : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  const failed = done.filter((d) => d.failed).length;
  return {
    text: `Worked for ${took} · ${groupSummary(done).replace(/^./, (c) => c.toLowerCase())}${failed > 0 ? ` · ${String(failed)} failed` : ""}`,
    failed: failed > 0,
  };
}

function ItemView({
  item,
  open = false,
  onToggle,
}: {
  readonly item: Item;
  /** For a foldable block: whether it is unfolded. */
  readonly open?: boolean;
  readonly onToggle?: () => void;
}): ReactNode {
  switch (item.kind) {
    case "user":
      return (
        <Box
          marginTop={1}
          borderStyle="bold"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.user}
          paddingLeft={1}
        >
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.brand} bold>
            ◆ Grafeno Agent
          </Text>
          <Box paddingLeft={2}>
            <Markdown text={item.text} />
          </Box>
        </Box>
      );
    case "tool":
      if (item.action) {
        return <ActionLine action={item.action} state={item.failed ? "failed" : "done"} />;
      }
      return (
        <Box paddingLeft={2} flexDirection="column">
          <Text>
            <Text color={item.failed ? theme.error : theme.success}>{item.failed ? "✗" : "✓"}</Text>
            <Text dimColor> {item.label}</Text>
          </Text>
          {item.detail !== undefined && (
            <Text color={theme.error} dimColor>
              {"  "}
              {item.detail}
            </Text>
          )}
        </Box>
      );
    case "memory":
      return <MemoryLine recall={item.recall} />;
    case "result":
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={item.failed ? theme.warning : theme.success}>
            {item.failed ? "!" : "✓"} {item.text}
          </Text>
        </Box>
      );
    case "notice": {
      const color = {
        info: theme.muted,
        success: theme.success,
        warning: theme.warning,
        error: theme.error,
      }[item.tone];
      const mark = { info: "·", success: "✓", warning: "!", error: "✗" }[item.tone];
      return (
        <Box marginTop={item.tone === "info" ? 0 : 1}>
          <Text color={color}>
            {mark} {item.text}
          </Text>
        </Box>
      );
    }
    case "block":
      if (item.foldable && !open) {
        return (
          <Clickable paddingLeft={2} onClick={onToggle}>
            <Text dimColor>
              ▸ {item.title} ({String(item.lines.length)} lines · click or ctrl+o)
            </Text>
          </Clickable>
        );
      }
      return (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={
            item.tone === "success"
              ? theme.success
              : item.tone === "warning"
                ? theme.warning
                : theme.border
          }
          paddingX={1}
        >
          <Clickable {...(item.foldable ? { onClick: onToggle } : {})}>
            <Text
              bold
              color={
                item.tone === "success"
                  ? theme.success
                  : item.tone === "warning"
                    ? theme.warning
                    : theme.accent
              }
            >
              {item.foldable ? "▾ " : ""}
              {item.title}
            </Text>
          </Clickable>
          {item.lines.map((line, index) => (
            <Text key={index}>{line === "" ? " " : line}</Text>
          ))}
        </Box>
      );
  }
}

/** What memory brought to a message, in a line under it. */
function MemoryLine({ recall }: { readonly recall: Recall }): ReactNode {
  const count = recall.memories.length;
  if (count === 0 && recall.facts === 0) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.border}>◇ memory · nothing relevant yet</Text>
      </Box>
    );
  }
  const names = recall.memories.slice(0, 3).join(" · ");
  return (
    <Box paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text color={theme.brand}>◆ memory</Text>
        <Text dimColor>
          {" "}
          · {String(count)} recalled
          {recall.facts > 0 ? `, ${String(recall.facts)} fact${recall.facts === 1 ? "" : "s"}` : ""}
          {names !== "" ? ` · ${names}${count > 3 ? " …" : ""}` : ""}
        </Text>
      </Text>
    </Box>
  );
}

function Working({ label, hint }: { readonly label: string; readonly hint: string }): ReactNode {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <Box flexShrink={0}>
      <Spinner />
      <Text color={theme.accent}> {label}…</Text>
      <Text dimColor>
        {" "}
        {String(Math.floor((now - since) / 1000))}s{hint ? ` · ${hint}` : ""}
      </Text>
    </Box>
  );
}

/** Keys pressed this soon after a permission request appears are not taken as its answer. */
const APPROVAL_GRACE_MS = 600;

/** What a permission request was about, in a line: its first line, with the command or path it names. */
export function approvalSummary(what: string): string {
  const lines = what
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? what;
  const summary = first.endsWith(":") && lines[1] !== undefined ? `${first} ${lines[1]}` : first;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function ApprovalBox({
  approval,
  waiting,
  onAnswer,
}: {
  readonly approval: Approval;
  readonly waiting: number;
  readonly onAnswer: (allowed: boolean) => void;
}): ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>
        Permission needed{waiting > 0 ? ` · ${String(waiting)} more waiting` : ""}
      </Text>
      <Text>The agent wants to {approval.what}</Text>
      {approval.reason !== undefined && <Text dimColor>{approval.reason}</Text>}
      <Box gap={2}>
        <Clickable
          onClick={() => {
            onAnswer(true);
          }}
        >
          <Text color={theme.success} bold inverse>
            {" y allow "}
          </Text>
        </Clickable>
        <Clickable
          onClick={() => {
            onAnswer(false);
          }}
        >
          <Text color={theme.error} bold inverse>
            {" n don’t allow "}
          </Text>
        </Clickable>
        <Text dimColor>click, or y / n / esc · enter does not answer</Text>
      </Box>
    </Box>
  );
}

/** The commands the menu bar offers, in order: each button does what its command does. */
const MENU: readonly (readonly [label: string, command: string])[] = [
  ["Projects", "projects"],
  ["New", "new"],
  ["Sessions", "resume"],
  ["Model", "models"],
  ["Effort", "effort"],
  ["Provider", "connect"],
  ["Mode", "mode"],
  ["Permissions", "permissions"],
  ["Memory", "palace"],
  ["Runs", "runs"],
  ["Agents", "agents"],
  ["Usage", "usage"],
  ["Help", "help"],
];

/** The menu each button opens, when it opens one: a second click on it closes it. */
const MENU_MODE: Readonly<Record<string, Mode>> = {
  projects: "projects",
  resume: "resume",
  models: "models",
  effort: "effort",
  connect: "connect",
  mode: "mode",
  permissions: "permissions",
  palace: "palace",
  runs: "runs",
  agents: "agents",
};

/** Buttons that only look, so they stay on while the agent works. */
const WHILE_BUSY = new Set(["agents", "usage", "help", "runs", "permissions"]);

/**
 * A row of buttons under the header: the main commands, one click each.
 * The menu open now shows pressed; clicking it again closes it, clicking
 * another one moves to it.
 */
function MenuBar({
  open,
  busy,
  blocked,
  onCommand,
}: {
  /** The menu open now, if any. */
  readonly open: Mode;
  readonly busy: boolean;
  /** A question waits for an answer: nothing else may be clicked. */
  readonly blocked: boolean;
  readonly onCommand: (command: string, close: boolean) => void;
}): ReactNode {
  return (
    <Box paddingX={1} gap={1} flexShrink={0} height={1} overflow="hidden">
      {MENU.map(([label, command]) => {
        const pressed = MENU_MODE[command] === open;
        const enabled = !blocked && (!busy || WHILE_BUSY.has(command) || pressed);
        return (
          <Clickable
            key={command}
            flexShrink={0}
            {...(enabled
              ? {
                  onClick: () => {
                    onCommand(command, pressed);
                  },
                }
              : {})}
          >
            {pressed ? (
              <Text inverse bold color={theme.brand}>
                [{label}]
              </Text>
            ) : (
              <Text {...(enabled ? { color: theme.brand } : { dimColor: true })}>[{label}]</Text>
            )}
          </Clickable>
        );
      })}
    </Box>
  );
}

function helpLines(): string[] {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    ...COMMANDS.map(
      (c) =>
        `/${c.name.padEnd(width)}${c.description}${c.aliases ? ` (also /${c.aliases.join(", /")})` : ""}`,
    ),
    "",
    "Keys",
    "  enter           send",
    "  \\ then enter    new line (or shift+enter)",
    "  ↑ ↓             earlier messages; in a list, move",
    "  tab             complete a command",
    "  pgup / pgdn     scroll the conversation (or the mouse wheel)",
    "  ctrl+o          unfold or fold every group of actions (a click does one)",
    "  shift + mouse   select text to copy",
    "  ctrl+b          show or hide the side panel",
    "  esc             interrupt the answer",
    "  ctrl+c          interrupt, or leave",
  ];
}

/** A provider's plan windows, as bars. */
function limitLines(usage: ProviderUsage | undefined, providerName?: string): string[] {
  const lines: string[] = [`${providerName ?? "Provider"}${usage?.note ? ` · ${usage.note}` : ""}`];
  if (usage) {
    for (const limit of usage.limits) {
      const cells = bar(limit.used, 20);
      const resets = shortResets(limit.resets);
      lines.push(
        `  ${limit.label.padEnd(20)} ${cells.filled}${cells.empty} ${String(Math.round(limit.used * 100)).padStart(3)}%`,
      );
      if (resets) lines.push(`  ${" ".repeat(20)} resets ${resets}`);
    }
    lines.push(`  (as the provider reports it, ${ago(usage.at)})`);
  } else {
    lines.push("  The provider did not say its usage.");
  }
  return lines;
}

function usageLines(
  session: AgentSession,
  usage: ProviderUsage | undefined,
  providerName?: string,
): string[] {
  // A model server of the person's own has no quota or credits: only the tokens below.
  const lines = isLocalProvider(session.provider.id)
    ? [
        `${providerName ?? session.provider.name} runs on a server of your own: no quota or credits; only the tokens are counted.`,
      ]
    : limitLines(usage, providerName);
  const u = session.usage;
  lines.push(
    "",
    `This session: ${String(session.turns)} turn${session.turns === 1 ? "" : "s"}`,
    `  input ${compact(u.inputTokens)} · cache ${compact(u.cacheReadTokens)} read, ${compact(u.cacheWriteTokens)} written · output ${compact(u.outputTokens)}`,
  );
  if (session.context) {
    lines.push(
      `  context ${compact(session.context.used)}${session.context.window ? ` of ${compact(session.context.window)}` : ""} tokens`,
    );
  }
  return lines;
}

function statusLines(
  session: AgentSession | undefined,
  services: AppServices,
  status: ProviderStatus | undefined,
  models: readonly ModelOption[],
): string[] {
  const grafeno = services.grafeno();
  const provider = session?.provider ?? services.providers[0];
  const signed = status
    ? ` · ${status.signedIn ? `signed in${status.plan ? ` (${status.plan})` : ""}` : "not signed in"}`
    : "";
  const lines = [
    `provider   ${provider?.name ?? "none"}${signed}`,
    `Grafeno    ${grafeno.mode === "included" ? "included" : "server"} · ${grafeno.url} · namespace ${grafeno.namespace}`,
    `settings   ${services.settingsPath}`,
  ];
  if (!session) return [...lines, "session    not connected (/palace, /connect)"];
  return [
    ...lines,
    `model      ${modelLine(session, models)}${session.modelId ? ` (${session.modelId})` : ""}`,
    `agent      ${session.identity?.name ?? "unnamed"}${session.identity?.ownOnly ? " · own-only key" : ""}`,
    `project    ${session.memory.project.name}${session.memory.project.path ? ` · ${session.memory.project.path}` : ""}`,
    `palace     ${session.memory.palace}`,
    `meaning    ${session.config.embedder}`,
    `kept in    ${session.store.dir}`,
  ];
}

/** A kept conversation's entries, as items to show again. */
function replay(entries: readonly Entry[]): NewItem[] {
  return entries.flatMap((entry): NewItem[] => {
    switch (entry.kind) {
      case "user":
        return [{ kind: "user", text: entry.text }];
      case "assistant":
        return [{ kind: "assistant", text: entry.text }];
      case "tool":
        return [
          {
            kind: "tool",
            label: entry.text.split("\n", 1)[0] ?? "tool",
            failed: entry.failed === true,
          },
        ];
      case "notice":
        return [];
    }
  });
}
