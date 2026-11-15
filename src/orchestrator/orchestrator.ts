import type { PermissionMode } from "../agent/permissions.js";
import { CapabilityRegistry } from "../providers/registry.js";
import { PROVIDER_SECRET_ENV } from "../providers/index.js";
import { assertBillingAllowed } from "../providers/billing.js";
import { join } from "node:path";
import type { Tool } from "../agent/tools.js";
import type { Embedder } from "../embed/types.js";
import type { Project } from "../memory/session.js";
import type { Vault } from "../memory/vault.js";
import type { Model } from "../model/index.js";
import type { ModelChoice, Provider } from "../providers/types.js";
import { projectTools } from "../tools/index.js";
import type { RouterMode } from "./learned.js";
import { limitReached, type RunLimits } from "./limits.js";
import { applyReplan, proposeReplan, type ReplanProposal } from "./replan.js";
import { crossReview } from "./review.js";
import type { AttemptContext } from "./scheduler.js";
import type { TaskRecord } from "./store.js";
import { MetricsStore } from "./metrics.js";
import { computeStats } from "./stats.js";
import { workerMemory } from "./memory.js";
import type { TaskKind, TaskSpec } from "./plan.js";
import { makePlan, type Planned } from "./planner.js";
import { TaskPipeline } from "./pipeline.js";
import { Policy, type Autonomy, type Question } from "./policy.js";
import type { Affinity, Profile, Route } from "./router.js";
import { Scheduler, type SchedulerChange } from "./scheduler.js";
import type { RunState } from "./states.js";
import { SqliteStore, type OperationalStore, type Run } from "./store.js";
import { runReport, type RunReport } from "./telemetry.js";
import { shellRunner, verifier, verify, type CommandRunner } from "./verify.js";
import { deliver, type Delivery } from "./deliver.js";
import { Workspace } from "../tools/workspace.js";
import {
  WorkerPool,
  type ActiveWorker,
  type ContextPolicy,
  type WorkerActivity,
} from "./workers.js";
import { runGit, WorktreeManager } from "./worktrees.js";

/** Where the orchestrator keeps runs and worktrees: the agent's data folder. */
import { dataDir } from "../data-dir.js";
export { dataDir };

/** Where a project's runs are kept, in the data folder. */
export function runStoreFile(root: string, project: string): string {
  return join(root, "runs", `${folderOf(project)}.db`);
}

function folderOf(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "_";
}

export interface OrchestratorOptions {
  readonly provider: Provider;
  readonly project: Project;
  /** The project's folder (a git repository for isolation). */
  readonly projectRoot: string;
  /** Memory in Grafeno; without it, workers have none. */
  readonly vault?: Vault;
  readonly embedder?: Embedder;
  /** Secrets never stored or shown (the agent's key). */
  readonly secrets?: readonly string[];
  readonly mode?: Autonomy;
  /** The person's permission mode for the workers' calls (see `Policy`). */
  readonly permissions?: PermissionMode;
  readonly maxWorkers?: number;
  readonly maxAttempts?: number;
  readonly attemptTimeoutMs?: number;
  /**
   * Several providers, in order of preference (phase B): each task goes to
   * one that is ready and has room; one that hits its limit or loses its
   * sign-in is set aside and its tasks go to another. `provider` alone is
   * phase A's single provider.
   */
  readonly providers?: readonly Provider[];
  /** A provider for some task kinds, when it is ready. */
  readonly providerFor?: Partial<Record<TaskKind, string>>;
  /**
   * General Auto (B7): every ready provider is one pool; each task kind goes
   * first to its affinity, ties are spread, and the planner comes from the
   * same pool (with the provider it was routed to).
   */
  readonly auto?: boolean;
  /** For each task kind, its preferred provider and tier, in General Auto. */
  readonly affinity?: Partial<Record<TaskKind, Affinity>>;
  /** Profiles per task kind (tier and effort); for example, all light for a cheap run. */
  readonly profiles?: Partial<Record<TaskKind, Profile>>;
  /** The planner's model and effort; default: what the router gives an architecture task. */
  readonly planner?: ModelChoice;
  readonly context?: ContextPolicy;
  /** Asks a person (the interface); without it, what needs a person is refused or waits in review. */
  readonly ask?: (question: Question) => Promise<boolean>;
  /** Where runs and worktrees go. Default: the agent's data folder. */
  readonly dataDir?: string;
  /**
   * Phase C's metrics, across all projects; default: `metrics.db` in the
   * data folder. `false`: none are kept.
   */
  readonly metrics?: MetricsStore | false;
  /**
   * Phase C's router: `learned` (the default) records a suggestion for each
   * task and uses it under the rule decided with the user; `shadow` only
   * records it; `rules` leaves learning out.
   */
  readonly router?: RouterMode;
  /**
   * Phase C4: a small share of low-risk tasks try a less-sampled model to
   * learn from. Off unless set (`AGENT_ROUTER_EXPLORE=true`), as decided.
   */
  readonly explore?: boolean | { readonly share?: number; readonly random?: () => number };
  /** Limits for the whole run (phase D2): tokens, work time, failed attempts. */
  readonly limits?: RunLimits;
  /**
   * Cross review (phase D5): after a task's checks pass, a reviewer on
   * another model may send it back with issues, for a bounded number of
   * rounds; it never approves. `true`: every kind but docs, two rounds.
   */
  readonly review?: boolean | { readonly rounds?: number; readonly kinds?: readonly TaskKind[] };
  /**
   * Phase D4: how this process owns the runs it runs. It always records its
   * pid and beats its heart in the store, and takes orders (pause, cancel)
   * sent from another process. `background`: started by `--background`, so
   * resumed on its own after a reboot, in `cwd`, with `args`.
   */
  readonly owner?: {
    readonly background?: boolean;
    readonly cwd?: string;
    readonly args?: readonly string[];
    /** How often the heart beats and orders are read. Default: 3 seconds. */
    readonly heartbeatMs?: number;
  };
  /** For tests. */
  readonly store?: OperationalStore;
  readonly tools?: (workspace: Workspace) => Tool[];
  readonly makeModel?: (choice: ModelChoice) => Model;
  readonly commandRunner?: CommandRunner;
  readonly onChange?: (change: SchedulerChange) => void;
  readonly onWorkers?: (active: readonly ActiveWorker[]) => void;
  /** What each worker does as it works, for an interface to show (never stored). */
  readonly onActivity?: (activity: WorkerActivity) => void;
}

/**
 * Runs a request as a plan of tasks done by several workers: the planner
 * writes the plan, code checks it; the scheduler runs the tasks in their own
 * worktrees with workers that share memory through Grafeno; each task is
 * verified by code and merged into the run's integration branch, under the
 * run's policy. Everything is kept in the operational store, so a run can be
 * resumed after the process ends.
 */
export class Orchestrator {
  readonly store: OperationalStore;
  readonly worktrees: WorktreeManager;
  readonly policy: Policy;
  readonly pool: WorkerPool;
  /** What each provider can do, when there are several. */
  readonly registry: CapabilityRegistry | undefined;
  readonly pipeline: TaskPipeline;
  /** Where every run's attempts and outcomes go, for the router to learn from. */
  readonly metrics: MetricsStore | undefined;
  #scheduler: Scheduler | undefined;
  /** An order given before the scheduler started running (it resets its own when it starts). */
  #order: "pause" | "cancel" | undefined;

  constructor(private readonly options: OrchestratorOptions) {
    const root = options.dataDir ?? dataDir();
    const folder = folderOf(options.project.name);
    this.store = options.store ?? new SqliteStore(join(root, "runs", `${folder}.db`));
    this.metrics =
      options.metrics === false
        ? undefined
        : (options.metrics ?? new MetricsStore(join(root, "metrics.db")));
    this.worktrees = new WorktreeManager({
      repo: options.projectRoot,
      root: join(root, "worktrees", folder),
    });
    this.policy = new Policy({
      mode: options.mode ?? "controlled",
      ...(options.permissions ? { permissions: options.permissions } : {}),
    });
    const secrets = options.secrets ?? [];
    const providers = options.providers ?? [options.provider];
    this.registry =
      providers.length > 1
        ? new CapabilityRegistry({ providers, file: join(root, "capabilities.json") })
        : undefined;
    this.pool = new WorkerPool({
      provider: options.provider,
      ...(providers.length > 1 ? { providers } : {}),
      ...(this.registry ? { registry: this.registry } : {}),
      ...(options.providerFor ? { providerFor: options.providerFor } : {}),
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.affinity ? { affinity: options.affinity } : {}),
      ...(this.metrics && (options.router ?? "learned") !== "rules"
        ? {
            learning: {
              mode: options.router === "shadow" ? ("shadow" as const) : ("learned" as const),
              ...(options.explore
                ? { explore: options.explore === true ? {} : options.explore }
                : {}),
              stats: () => {
                const metrics = this.metrics;
                return metrics ? computeStats(metrics.attempts(), metrics.outcomes()) : [];
              },
            },
          }
        : {}),
      effectInFlight: (runId, taskId) =>
        this.store.effectsInFlight(runId).some((key) => key.endsWith(`:${taskId}`)),
      workspaceFor: (task, context) => this.pipeline.workspaceFor(task, context),
      tools:
        options.tools ??
        ((workspace) =>
          projectTools(workspace, {
            hiddenEnv: ["GRAFENO_AGENT_KEY", "GRAFENO_OWNER_TOKEN", ...PROVIDER_SECRET_ENV],
            // A worker's processes would outlive its task: workers run commands that end.
            background: false,
          })),
      redact: secrets,
      approverFor: (task, worker, context) =>
        this.policy.approver(
          { worker, task: task.id },
          options.ask,
          (question, answer) => {
            context.note("question", { ...question, answer });
          },
          task.spec.acceptance.flatMap((check) => (check.check === "command" ? [check.run] : [])),
        ),
      ...(options.vault
        ? {
            memoryFor: workerMemory({
              vault: options.vault,
              project: options.project,
              knownSecrets: secrets,
              ...(options.embedder ? { embedder: options.embedder } : {}),
            }),
          }
        : {}),
      ...(options.profiles ? { profiles: options.profiles } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.makeModel ? { makeModel: options.makeModel } : {}),
      ...(options.onWorkers ? { onChange: options.onWorkers } : {}),
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });
    this.pipeline = new TaskPipeline({
      store: this.store,
      projectRoot: options.projectRoot,
      worktrees: this.worktrees,
      inner: () => this.pool,
      verify: verifier({
        redact: secrets,
        runner: options.commandRunner ?? checksRunner(),
      }),
      policy: this.policy,
      ...(options.ask ? { ask: options.ask } : {}),
      ...(options.review ? { review: this.#reviewing(options.review) } : {}),
    });
  }

  /**
   * Phase D5: who reviews and how. The reviewer is routed as a review task
   * (the user's affinity: a deep Claude model), and recorded as independent
   * when its model differs from the worker's.
   */
  #reviewing(setting: true | { readonly rounds?: number; readonly kinds?: readonly TaskKind[] }) {
    const kinds = setting === true || !setting.kinds ? undefined : new Set(setting.kinds);
    return {
      for: (task: TaskRecord) => (kinds ? kinds.has(task.spec.kind) : task.spec.kind !== "docs"),
      ask: async (task: TaskRecord, diff: string, context: AttemptContext) => {
        const route = await this.pool.routeFor({
          ...task.spec,
          id: `review-${task.id}`,
          kind: "review",
          dependsOn: [],
        });
        if (route.kind === "hold") {
          return {
            verdict: { verdict: "none" as const, reason: `no reviewer now: ${route.reason}` },
            reviewer: "none",
            independent: false,
          };
        }
        const choice = {
          ...(route.model === "default" ? {} : { model: route.model }),
          ...(route.effort ? { effort: route.effort } : {}),
        };
        const model =
          this.options.makeModel?.(choice) ?? this.pool.providerById(route.provider).create(choice);
        const reviewer = `${route.provider}/${route.model}`;
        const worker = this.store.task(context.runId, task.id)?.model ?? "";
        return {
          verdict: await crossReview(model, task.spec, diff, context.signal),
          reviewer,
          independent:
            worker !== reviewer && !worker.endsWith(`/${route.model}`) && worker !== route.model,
        };
      },
      ...(setting !== true && setting.rounds !== undefined ? { rounds: setting.rounds } : {}),
      maxAttempts: this.options.maxAttempts ?? 3,
    };
  }

  /** Writes and checks a plan for a request; nothing runs yet. */
  async plan(
    request: string,
    signal?: AbortSignal,
  ): Promise<Planned & { routes: Map<string, Route>; planner: string }> {
    await this.#billingAllowed();
    // The planner's model, made with the provider it was routed to.
    const planner = this.options.planner
      ? { choice: this.options.planner, provider: this.options.provider }
      : await this.#plannerChoice();
    const model =
      this.options.makeModel?.(planner.choice) ?? planner.provider.create(planner.choice);
    const planned = await makePlan(
      { request, context: await this.#projectContext() },
      { model, ...(signal ? { signal } : {}) },
    );
    // Routed in order, counting what each provider was given, as the run will.
    const routes = new Map<string, Route>();
    const assigned = new Map<string, number>();
    for (const id of planned.order) {
      const task = planned.plan.tasks.find((t) => t.id === id);
      if (!task) continue;
      const route = await this.pool.routeFor(task, assigned);
      if (route.kind === "run")
        assigned.set(route.provider, (assigned.get(route.provider) ?? 0) + 1);
      routes.set(task.id, route);
    }
    return { ...planned, routes, planner: plannerLabel(planner) };
  }

  /** Stores a checked plan as a run, from the project's HEAD; says what the run will not see. */
  async start(request: string, planned: Planned): Promise<{ run: Run; uncommitted: string[] }> {
    const isolated = await this.pipeline.isolated();
    const base = isolated ? await this.worktrees.head() : undefined;
    const uncommitted = isolated ? await this.worktrees.uncommitted() : [];
    const run = this.store.createRun(request, planned.plan, planned.order, base);
    this.store.event(run.id, "planned", {
      attempts: planned.attempts,
      mode: this.policy.mode,
      isolated,
    });
    if (uncommitted.length > 0)
      this.store.event(run.id, "uncommitted", { files: uncommitted.length });
    return { run, uncommitted };
  }

  /**
   * Runs (or resumes) a run until nothing more can happen now. When it is
   * completed, worktrees that are safe to remove are removed; the
   * integration branch stays for the user.
   */
  async run(runId: string): Promise<RunState> {
    const scheduler = new Scheduler({
      store: this.store,
      runner: this.pipeline,
      maxWorkers: this.options.maxWorkers ?? 3,
      ...(this.options.maxAttempts ? { maxAttempts: this.options.maxAttempts } : {}),
      ...(this.options.attemptTimeoutMs ? { attemptTimeoutMs: this.options.attemptTimeoutMs } : {}),
      ...(this.options.onChange ? { onChange: this.options.onChange } : {}),
      ...(this.options.limits
        ? {
            limit: (id: string) => limitReached(this.store, id, this.options.limits ?? {}),
          }
        : {}),
    });
    this.#scheduler = scheduler;
    const cpu = process.cpuUsage();
    // Phase D4: this process owns the run while it runs it.
    const owner = this.options.owner ?? {};
    this.store.supervise(runId, {
      pid: process.pid,
      background: owner.background === true,
      ...(owner.cwd ? { cwd: owner.cwd } : {}),
      ...(owner.args ? { args: owner.args } : {}),
    });
    const obey = () => {
      const order = this.store.takeControl(runId);
      if (order === "pause") scheduler.pause();
      else if (order === "cancel") scheduler.cancel();
    };
    obey();
    const beat = setInterval(() => {
      this.store.heartbeat(runId, process.pid);
      obey();
    }, owner.heartbeatMs ?? 3000);
    try {
      // After the scheduler exists, so a pause or cancel sent meanwhile is kept.
      await this.#billingAllowed();
      const running = scheduler.run(runId);
      if (this.#order === "pause") scheduler.pause();
      else if (this.#order === "cancel") scheduler.cancel();
      this.#order = undefined;
      const state = await running;
      if (state === "completed" && this.policy.action("merge-user").decision === "allow") {
        // Phase D6: only in the extended mode, the work goes into the user's branch.
        await this.deliver(runId);
      }
      if (state === "completed" || state === "cancelled") await this.pipeline.finish(runId);
      return state;
    } finally {
      this.#scheduler = undefined;
      this.#order = undefined;
      clearInterval(beat);
      this.store.unsupervise(runId);
      // What this process used while it ran the run, where Node can measure it
      // (phase D2): its own memory and CPU, not the providers' processes.
      const spent = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      this.store.event(runId, "resources", {
        rssMb: Math.round(memory.rss / 1_048_576),
        heapMb: Math.round(memory.heapUsed / 1_048_576),
        cpuUserMs: Math.round(spent.user / 1000),
        cpuSystemMs: Math.round(spent.system / 1000),
      });
      // What the run taught, for phase C; a failure here never fails the run.
      try {
        this.metrics?.recordRun(this.store, runId, this.options.project.name);
      } catch {
        // The run's own store still holds everything; it can be imported later.
      }
    }
  }

  /**
   * Runs a run and, when a task fails for good, replans what failed (phase
   * D3) and goes on, a bounded number of times. In the extended mode a
   * replan is applied on its own; otherwise `confirm` is asked, and without
   * it nothing is replanned. Each replan is recorded with what it replaced.
   */
  async runWithReplans(
    runId: string,
    confirm?: (proposal: ReplanProposal) => Promise<boolean>,
    onReplan?: (proposal: ReplanProposal) => void,
  ): Promise<RunState> {
    for (;;) {
      const state = await this.run(runId);
      if (state !== "failed") return state;
      let proposal: ReplanProposal;
      try {
        proposal = await this.proposeReplan(runId);
      } catch (error) {
        this.store.event(runId, "replan_refused", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return state;
      }
      const yes = this.policy.mode === "extended" ? true : ((await confirm?.(proposal)) ?? false);
      if (!yes) {
        this.store.event(runId, "replan_declined", { replaced: [...proposal.replaced] });
        return state;
      }
      this.applyReplan(proposal);
      onReplan?.(proposal);
    }
  }

  /** New tasks in place of what failed, from the planner's model; nothing applied yet. */
  async proposeReplan(runId: string, signal?: AbortSignal): Promise<ReplanProposal> {
    const planner = this.options.planner
      ? { choice: this.options.planner, provider: this.options.provider }
      : await this.#plannerChoice();
    const model =
      this.options.makeModel?.(planner.choice) ?? planner.provider.create(planner.choice);
    return proposeReplan(this.store, runId, model, signal ? { signal } : {});
  }

  applyReplan(proposal: ReplanProposal): void {
    applyReplan(this.store, proposal);
  }

  pause(): void {
    this.#order = "pause";
    this.#scheduler?.pause();
  }

  cancel(): void {
    this.#order = "cancel";
    this.#scheduler?.cancel();
  }

  runs(): Run[] {
    return this.store.runs();
  }

  report(runId: string): RunReport {
    return runReport(this.store, runId);
  }

  /**
   * Merges a completed run's work into the user's current branch, checks it
   * there and undoes it when a check fails (phase D6). `run` does this on
   * its own only in the extended mode; nothing is ever pushed.
   */
  async deliver(runId: string): Promise<Delivery> {
    if (!(await this.pipeline.isolated())) {
      return { status: "skipped", reason: "the project is not a git repository" };
    }
    const acceptance = this.store
      .tasks(runId)
      .filter((t) => t.state === "completed")
      .flatMap((t) => t.spec.acceptance);
    const unique = [...new Map(acceptance.map((a) => [JSON.stringify(a), a])).values()];
    return deliver({
      store: this.store,
      worktrees: this.worktrees,
      runId,
      checks: (root) =>
        verify(unique, new Workspace(root), {
          redact: this.options.secrets ?? [],
          runner: this.options.commandRunner ?? checksRunner(),
        }),
    });
  }

  /** What became of the user's branch at the end of the run, when anything was tried (phase D6). */
  delivery(runId: string): Delivery | undefined {
    const event = this.store
      .events(runId)
      .filter((e) => e.kind === "delivery")
      .at(-1);
    return event ? (event.data as unknown as Delivery) : undefined;
  }

  /** The run's integration branch, where its work landed. */
  integrationBranch(runId: string): string {
    return this.worktrees.integrationBranch(runId);
  }

  close(): void {
    this.store.close();
    if (this.options.metrics === undefined) this.metrics?.close();
  }

  async #plannerChoice(): Promise<{ choice: ModelChoice; provider: Provider; model: string }> {
    const probe: TaskSpec = {
      id: "plan",
      title: "Plan",
      description: "",
      kind: "architecture",
      dependsOn: [],
      complexity: 3,
      capabilities: [],
      touches: [],
      acceptance: [{ check: "files", exist: ["."] }],
      parallelSafe: true,
    };
    const route = await this.pool.routeFor(probe);
    if (route.kind === "hold") throw new Error(`Not planning now: ${route.reason}`);
    return {
      choice: {
        ...(route.model === "default" ? {} : { model: route.model }),
        ...(route.effort ? { effort: route.effort } : {}),
      },
      provider: this.pool.providerById(route.provider),
      model: route.model,
    };
  }

  /**
   * One provider and no registry: it must not bill by consumption unless the
   * user allowed it. With several, the registry leaves such providers out.
   */
  async #billingAllowed(): Promise<void> {
    if (!this.registry) await assertBillingAllowed(this.options.provider);
  }

  /** What the planner is told about the project: its files, as data. */
  async #projectContext(): Promise<string> {
    const files = await runGit(this.options.projectRoot, ["ls-files"]);
    const list = files.code === 0 ? files.stdout.split("\n").filter(Boolean) : [];
    const shown = list.slice(0, 150);
    return [
      `Project: ${this.options.project.name}`,
      list.length > 0
        ? `Files (${String(list.length)}${list.length > shown.length ? `, first ${String(shown.length)}` : ""}):\n${shown.join("\n")}`
        : "The project has no files under git yet.",
    ].join("\n\n");
  }
}

/**
 * The shell that runs acceptance checks: like the workers' commands, it
 * never sees the agent's or the providers' keys.
 */
export function checksRunner(): CommandRunner {
  return shellRunner({
    hiddenEnv: ["GRAFENO_AGENT_KEY", "GRAFENO_OWNER_TOKEN", ...PROVIDER_SECRET_ENV],
  });
}

/** Who planned, for the plan view: `provider/model · effort`. */
function plannerLabel(planner: {
  choice: ModelChoice;
  provider: Provider;
  model?: string;
}): string {
  const model = planner.model ?? planner.choice.model ?? "default";
  return `${planner.provider.id}/${model}${planner.choice.effort ? ` · ${planner.choice.effort}` : ""}`;
}
