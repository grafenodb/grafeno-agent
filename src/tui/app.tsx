import { Box, measureElement, Text, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { readEnvironment, type Environment } from "../app/environment.js";
import type { AppServices } from "../app/services.js";
import { describeCall, type AgentSession } from "../app/session.js";
import { describeError } from "../chat.js";
import type { ToolCall } from "../model/index.js";
import { API_KEY_PROVIDERS, autoMembers, isAuto, providerIds } from "../providers/index.js";
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
import { withActivity, withState, withTasks, withWorkers, type SubAgent } from "./agents.js";
import { AgentsPanel, AgentView, agentKey } from "./agents-panel.js";
import { describePlan } from "../app/orchestrate.js";
import { useWheel } from "./mouse.js";
import { PalacePanel } from "./palace.js";
import { Picker, type PickerItem } from "./picker.js";
import { Prompt } from "./prompt.js";
import { ProviderPanel } from "./provider.js";
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
    }
  | { readonly id: number; readonly kind: "notice"; readonly text: string; readonly tone: Tone }
  | { readonly id: number; readonly kind: "memory"; readonly recall: Recall }
  | {
      readonly id: number;
      readonly kind: "block";
      readonly title: string;
      readonly lines: readonly string[];
    };

type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Phase = "starting" | "setup-memory" | "setup-provider" | "ready" | "offline";
type Mode =
  | "chat"
  | "models"
  | "effort"
  | "resume"
  | "connect"
  | "palace"
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
  readonly id: string;
  readonly label: string;
}

export function App({ services }: { readonly services: AppServices }): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<Phase>(() =>
    services.needsSetup() ? "setup-memory" : "starting",
  );
  const [session, setSession] = useState<AgentSession | undefined>(undefined);
  // The provider the chat reasons with: the session's, which /connect may change.
  const provider = session?.provider ?? services.providers[0];
  // General Auto (B7c): each message is triaged, and may be orchestrated across providers.
  const [auto, setAuto] = useState(() => isAuto(process.env.AGENT_PROVIDERS));
  // The providers Auto includes (AGENT_AUTO_PROVIDERS): by default, the official CLIs only.
  // In Auto, the usage of each provider it includes, for the side panel.
  const [autoUsage, setAutoUsage] = useState<readonly AutoUsage[]>([]);
  const [autoIds, setAutoIds] = useState<readonly string[]>(() => {
    try {
      return autoMembers(process.env);
    } catch {
      return [];
    }
  });
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<Mode>("chat");
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [live, setLive] = useState("");
  const [tools, setTools] = useState<LiveTool[]>([]);
  const [approval, setApproval] = useState<Approval | undefined>(undefined);
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
  const refreshAutoUsage = useCallback(
    async (afterTurn = false) => {
      if (!auto || autoIds.length === 0) {
        setAutoUsage([]);
        return;
      }
      const members = services.providers.filter((p) => autoIds.includes(p.id));
      const found = await Promise.all(
        members.map(async (p) => {
          const current = p.id === session?.provider.id;
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
      let buffer = "";
      const flush = () => {
        if (buffer.trim() !== "") push({ kind: "assistant", text: buffer });
        buffer = "";
        setLive("");
      };
      try {
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
                setTools((current) => [...current, { id: event.call.id, label: callLabel }]);
                break;
              }
              case "tool_result": {
                setTools((current) => current.filter((t) => t.id !== event.callId));
                const first = event.outcome.content.split("\n", 1)[0] ?? "";
                push({
                  kind: "tool",
                  label: labels.get(event.callId) ?? "tool",
                  failed: event.outcome.isError === true,
                  ...(event.outcome.isError === true ? { detail: first.slice(0, 160) } : {}),
                });
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
        if (turn.restarted) {
          notice("The conversation with the model had ended and was started again.", "warning");
        }
        if (turn.result.stopReason === "max_steps")
          notice("Stopped at the step limit for one turn.", "warning");
        else if (turn.result.stopReason === "max_tokens")
          notice("The answer reached its length limit.", "warning");
        else if (turn.result.stopReason === "refusal")
          notice("The model declined to answer.", "warning");
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
          onActivity: (activity) => {
            setAgents((current) => withActivity(current, activity));
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
    [services],
  );

  /** Runs (or resumes) a run, watching it, and reports how it ended. */
  const driveRun = useCallback(
    async (
      orchestrator: Orchestrator,
      runId: string,
      options: { readonly forAgent?: boolean } = {},
    ): Promise<{ state: string; lines: string[] }> => {
      const tasks = orchestrator.store.tasks(runId).map((t) => ({
        id: t.id,
        title: t.spec.title,
        state: t.state,
        ...(t.reason ? { reason: t.reason } : {}),
      }));
      setWatched({ runId, state: "running", tasks, workers: [] });
      runNow.current = runId;
      setAgents((current) => withTasks(current, runId, tasks));
      orchestration.current = { orchestrator, running: true };
      // For the main agent's own call, its turn keeps the busy line.
      if (!options.forAgent) setBusy("Running the plan");
      let lines: string[];
      let state = "failed";
      try {
        state = await orchestrator.run(runId);
        lines = describeReport(orchestrator.report(runId));
        if (state === "completed") {
          const branch = orchestrator.integrationBranch(runId);
          lines.push("", `The work is on ${branch}. Look at it, then merge it when you are ready:`);
          lines.push(`  git diff HEAD...${branch}`, `  git merge ${branch}`);
        } else if (state === "paused" || state === "waiting") {
          lines.push("", `The run is ${state}: /runs takes it up again.`);
        }
        push({ kind: "block", title: "Run report", lines });
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
      return { state, lines };
    },
    [push, notice],
  );

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
      const run = await new Promise<boolean>((resolve) => {
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
          `Their work is on the branch ${branch}; the person merges it (git merge ${branch}).`,
        ].join("\n");
      } finally {
        signal.removeEventListener("abort", stop);
      }
    };
  }, [auto, autoIds, provider, openOrchestrator, driveRun, push]);

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
          setMode("plan");
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
        case "effort":
          setMode("effort");
          break;
        case "connect":
          setMode("connect");
          break;
        case "palace":
          setMode("palace");
          break;
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
                  .filter((other) => chosen.includes(other.id))
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
      auto,
      autoIds,
      agents,
    ],
  );

  const onWheel = useCallback((direction: number) => {
    setScroll((s) => Math.max(0, s + direction * 3));
  }, []);
  useWheel(onWheel);

  useInput((input, key) => {
    if (approval) {
      if (input === "y" || input === "Y" || input === "s") {
        approval.resolve(true);
        setApproval(undefined);
        notice(`Allowed: ${firstLine(approval.what)}`, "success");
      } else if (input === "n" || input === "N" || key.escape || key.return) {
        approval.resolve(false);
        setApproval(undefined);
        notice(`Not allowed: ${firstLine(approval.what)}`, "warning");
      }
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
    else if (key.ctrl && input === "b") setSidebarOn((on) => !on);
    else if (key.ctrl && (input === "n" || input === "p") && agents.length > 0) {
      // Through the main agent and its sub-agents.
      const keys = [undefined, ...agents.map(agentKey)];
      const at = keys.indexOf(viewing);
      const next = (at + (input === "n" ? 1 : keys.length - 1)) % keys.length;
      setViewing(keys[next]);
      setScroll(0);
    } else if (key.ctrl && input === "c") {
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

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Header
        session={session}
        models={models}
        grafeno={grafeno.mode}
        busy={busy !== undefined}
        narrow={!showSidebar}
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
          />
        )}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {viewed ? (
            <Viewport scroll={scroll} onClamp={setScroll}>
              <AgentView agent={viewed} />
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
              {items.map((item) => (
                <ItemView key={item.id} item={item} />
              ))}
              {live !== "" && (
                <Box marginTop={1} paddingLeft={2}>
                  <Markdown text={live} />
                </Box>
              )}
              {tools.map((tool) => (
                <Box key={tool.id} paddingLeft={2}>
                  <Spinner />
                  <Text color={theme.accent}> {tool.label}</Text>
                </Box>
              ))}
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
            {approval && <ApprovalBox approval={approval} />}
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
                  const { orchestrator, planned } = current;
                  void (async () => {
                    const { run, uncommitted } = await orchestrator.start(
                      current.request ?? "",
                      planned,
                    );
                    if (uncommitted.length > 0) {
                      notice(
                        `${String(uncommitted.length)} changed files are not committed: the run starts from your last commit and does not see them.`,
                        "warning",
                      );
                    }
                    await driveRun(orchestrator, run.id);
                  })();
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
              <Picker
                title="Resume a conversation"
                items={resumable}
                onCancel={() => {
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
                  void session.resume(item.id).then((saved) => {
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
            {mode === "connect" && (
              <ProviderPanel
                providers={services.providers}
                {...(provider && !auto ? { current: provider.id } : {})}
                auto={auto}
                autoMembers={autoIds}
                apiKeyProviders={API_KEY_PROVIDERS}
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
                onAuto={() => {
                  setMode("chat");
                  if (!session) return;
                  if (autoIds.length === 0) {
                    notice(
                      "Auto includes no provider yet: in /connect, mark the ones it may use with space, then choose Auto.",
                      "warning",
                    );
                    return;
                  }
                  setAuto(true);
                  services.saveChoice({ provider: "auto" });
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
                }}
                onDone={(found, chosen) => {
                  setMode("chat");
                  if (!found || !chosen) return;
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
                    notice(
                      `Provider: ${chosen.name}, model Auto. The conversation goes on with it.`,
                      "success",
                    );
                    setTick((t) => t + 1);
                  });
                }}
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
              <Box borderStyle="round" borderColor={theme.muted} paddingX={1}>
                <Text dimColor wrap="truncate-end">
                  Sub-agent {viewed.id} · read only: the main agent orchestrates it · ctrl+n /
                  ctrl+p switch · /agents
                </Text>
              </Box>
            )}
            {mode === "chat" && !approval && !viewed && (
              <Prompt
                active={busy === undefined && phase !== "starting"}
                placeholder={
                  phase === "starting"
                    ? "Connecting…"
                    : busy !== undefined
                      ? "Working… esc to interrupt"
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
        <Text dimColor wrap="truncate-end">
          {narrow
            ? "/ commands · pgup/pgdn · esc stop"
            : "enter send · / commands · pgup/pgdn scroll · ctrl+b panel · esc interrupt"}
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

function ItemView({ item }: { readonly item: Item }): ReactNode {
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
        <Box marginTop={1} paddingLeft={2}>
          <Markdown text={item.text} />
        </Box>
      );
    case "tool":
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
      return (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <Text bold color={theme.accent}>
            {item.title}
          </Text>
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

function ApprovalBox({ approval }: { readonly approval: Approval }): ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>
        Permission needed
      </Text>
      <Text>The agent wants to {approval.what}</Text>
      {approval.reason !== undefined && <Text dimColor>{approval.reason}</Text>}
      <Text>
        <Text color={theme.success} bold>
          y
        </Text>
        <Text> allow · </Text>
        <Text color={theme.error} bold>
          n
        </Text>
        <Text> don’t allow</Text>
      </Text>
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
  const lines = limitLines(usage, providerName);
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

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
