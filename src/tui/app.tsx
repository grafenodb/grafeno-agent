import { Box, measureElement, Text, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { readEnvironment, type Environment } from "../app/environment.js";
import type { AppServices } from "../app/services.js";
import { describeCall, type AgentSession } from "../app/session.js";
import { describeError } from "../chat.js";
import type { ToolCall } from "../model/index.js";
import { providerIds } from "../providers/index.js";
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
import { describePlan } from "../app/orchestrate.js";
import { useWheel } from "./mouse.js";
import { PalacePanel } from "./palace.js";
import { Picker, type PickerItem } from "./picker.js";
import { Prompt } from "./prompt.js";
import { ProviderPanel } from "./provider.js";
import { Sidebar } from "./sidebar.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export type { AppServices } from "../app/services.js";

/** Days between upkeeps before the interface suggests one. */
const UPKEEP_EVERY_DAYS = 7;
/** The side panel's width, and the narrowest window that still shows it. */
const SIDEBAR = 38;
const SIDEBAR_FROM = 100;
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
  "chat" | "models" | "effort" | "resume" | "connect" | "palace" | "plan" | "runs" | "exiting";

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
  const provider = services.providers[0];
  const [phase, setPhase] = useState<Phase>(() =>
    services.needsSetup() ? "setup-memory" : "starting",
  );
  const [session, setSession] = useState<AgentSession | undefined>(undefined);
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
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [environment, setEnvironment] = useState<Environment>({});
  const [recall, setRecall] = useState<Recall | undefined>(undefined);
  const [sidebarOn, setSidebarOn] = useState(true);
  const [scroll, setScroll] = useState(0);
  const [, setTick] = useState(0);
  const [watched, setWatched] = useState<Watched | undefined>(undefined);
  const [runChoices, setRunChoices] = useState<PickerItem[]>([]);
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

  /** The provider's real usage, at most once a minute unless asked. */
  const refreshUsage = useCallback(
    async (force = false) => {
      if (!provider || (!force && Date.now() - usageAt.current < 60_000)) return;
      usageAt.current = Date.now();
      const found = await provider.usage();
      if (found) setUsage(found);
    },
    [provider],
  );

  /** Starts a session with the settings as they are now. */
  const connect = useCallback(async () => {
    setPhase("starting");
    try {
      const fresh = await services.start();
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
    void refreshUsage(true);
  }, [provider, refreshUsage]);

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
        void refreshUsage();
      }
    },
    [push, notice, refreshUsage],
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
  const openOrchestrator = useCallback(async (): Promise<Orchestrator> => {
    return services.orchestrator({
      ask: (question) =>
        new Promise<boolean>((resolve) => {
          setApproval({
            what: `${question.action}${question.worker ? ` (${question.worker})` : ""}`,
            reason: question.reason,
            resolve,
          });
        }),
      onChange: (change) => {
        setWatched((current) => {
          if (!current) return current;
          if (change.type === "run") return { ...current, state: change.state };
          return {
            ...current,
            tasks: current.tasks.map((t) =>
              t.id === change.task
                ? { ...t, state: change.state, ...(change.reason ? { reason: change.reason } : {}) }
                : t,
            ),
          };
        });
      },
      onWorkers: (active) => {
        setWatched((current) => (current ? { ...current, workers: active } : current));
      },
    });
  }, [services]);

  /** Runs (or resumes) a run, watching it, and reports how it ended. */
  const driveRun = useCallback(
    async (orchestrator: Orchestrator, runId: string) => {
      const tasks = orchestrator.store.tasks(runId).map((t) => ({
        id: t.id,
        title: t.spec.title,
        state: t.state,
        ...(t.reason ? { reason: t.reason } : {}),
      }));
      setWatched({ runId, state: "running", tasks, workers: [] });
      orchestration.current = { orchestrator, running: true };
      setBusy("Running the plan");
      try {
        const state = await orchestrator.run(runId);
        const lines = describeReport(orchestrator.report(runId));
        if (state === "completed") {
          const branch = orchestrator.integrationBranch(runId);
          lines.push("", `The work is on ${branch}. Look at it, then merge it when you are ready:`);
          lines.push(`  git diff HEAD...${branch}`, `  git merge ${branch}`);
        } else if (state === "paused" || state === "waiting") {
          lines.push("", `The run is ${state}: /runs takes it up again.`);
        }
        push({ kind: "block", title: "Run report", lines });
      } catch (error) {
        notice(
          `The run stopped: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        setBusy(undefined);
        setWatched(undefined);
        orchestration.current = undefined;
        orchestrator.close();
      }
    },
    [push, notice],
  );

  /** What a line typed in the box does. */
  const submit = useCallback(
    async (line: string) => {
      const text = line.trim();
      if (text === "") return;
      setSent((current) => [...current.filter((s) => s !== text), text].slice(-100));
      const command = parseCommand(text);
      if (!command) {
        if (!session) {
          notice(
            "Not connected yet: /palace sets up the memory, /connect the provider.",
            "warning",
          );
          return;
        }
        await runTurn(session, text, text);
        return;
      }
      if (!command.known) {
        notice(`Unknown command /${command.name}. /help lists them.`, "error");
        return;
      }
      const free = ["help", "connect", "palace", "clear", "exit", "status", "sidebar"];
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
          setBusy("Asking the provider");
          let fresh = usage;
          // The other providers a run may use (AGENT_PROVIDERS), each with its own plan.
          const others: { name: string; usage: ProviderUsage | undefined }[] = [];
          try {
            if (provider) {
              usageAt.current = Date.now();
              fresh = (await provider.usage()) ?? usage;
              if (fresh) setUsage(fresh);
            }
            const chosen = providerIds(process.env.AGENT_PROVIDERS);
            for (const other of services.providers.slice(1)) {
              if (!chosen.includes(other.id)) continue;
              others.push({ name: other.name, usage: await other.usage().catch(() => undefined) });
            }
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
          setBusy("Planning");
          try {
            const orchestrator = await openOrchestrator();
            const planned = await orchestrator.plan(command.args);
            orchestration.current = {
              orchestrator,
              request: command.args,
              planned,
              running: false,
            };
            push({ kind: "block", title: "Plan", lines: describePlan(planned) });
            setMode("plan");
          } catch (error) {
            notice(`No plan: ${error instanceof Error ? error.message : String(error)}`, "error");
          } finally {
            setBusy(undefined);
          }
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
    else if (key.ctrl && input === "c") {
      if (busy !== undefined && abort.current) abort.current.abort();
      else if (mode === "exiting") exit();
      else if (mode !== "chat") setMode("chat");
      else void leave();
    }
  });

  const showSidebar = sidebarOn && columns >= SIDEBAR_FROM;
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
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
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
                  orchestration.current?.orchestrator.close();
                  orchestration.current = undefined;
                  setMode("chat");
                }}
                onSelect={(item) => {
                  setMode("chat");
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
                onDone={(found) => {
                  setMode("chat");
                  if (found) {
                    setStatus(found);
                    notice(
                      `${provider?.name ?? "Provider"}: ${found.detail}`,
                      found.signedIn ? "success" : "warning",
                    );
                  }
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
            {mode === "chat" && !approval && (
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
            models={models}
            environment={environment}
            recall={recall}
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
  const provider = services.providers[0];
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
