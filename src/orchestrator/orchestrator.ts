import { riskOf } from "./capability.js";
import { EXPLORE_SHARE } from "./learned.js";
import {
  sandboxManager,
  withSpawner,
  type SandboxManager,
  type Spawner,
} from "../sandbox/manager.js";
import { sandboxMode } from "../sandbox/policy.js";
import type { PermissionMode } from "../agent/permissions.js";
import { CostBook } from "./costs.js";
import { judge } from "./capability.js";
import { deriveRun, type AttemptRecord } from "./metrics.js";
import type { Decision, PriorAttempt } from "./sufficient.js";
import {
  Coordinator,
  coordinationTools,
  describeCoordination,
  modelDecider,
  type Decider,
  type WorkNote,
} from "./coordination.js";
import type { RoutingMode } from "./router.js";
import { CapabilityRegistry } from "../providers/registry.js";
import { PROVIDER_SECRET_ENV } from "../providers/index.js";
import { assertBillingAllowed } from "../providers/billing.js";
import { basename, dirname, join } from "node:path";
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
import {
  deliver,
  deliverPart,
  describeDelivery,
  type Delivery,
  type PartDelivery,
} from "./deliver.js";
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
  /** How eagerly the plans are spent (`AGENT_ROUTING`); without it, the rules as they were. */
  readonly routing?: RoutingMode;
  /**
   * How the run's work reaches the branch the user is on (`AGENT_DELIVERY`):
   * `live`, each task as soon as it is merged, and everything checked
   * together at the end; `end`, all of it when the run completes and its
   * checks pass; `manual`, only in the extended mode (as before), else the
   * person merges the integration branch. Without it, `manual`.
   */
  readonly delivery?: Delivery_Mode;
  /** Told what became of the work in the user's branch, task by task and at the end. */
  readonly onDelivered?: (info: { task?: string; lines: string[] }) => void;
  /** Told what workers report, and what they ask and how it was decided. */
  readonly onNote?: (note: WorkNote) => void;
  /** Decides workers' requests for more work; default: the planner's model. */
  readonly decideWork?: Decider;
  /** For each provider in General Auto, the models the person chose (`AGENT_AUTO_MODELS`). */
  readonly models?: Readonly<Record<string, readonly string[]>>;
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
  /**
   * The run's leader: one model of one of the run's providers, chosen by
   * the person. It plans the run and gives each task to a sub-agent (a
   * provider, and a model), decides the sub-agents' requests, and audits
   * every task after its checks pass: it approves it, or sends it back with
   * what to fix, and leaves suggestions for the tasks after it.
   */
  readonly leader?: {
    readonly provider: string;
    readonly model?: string;
    readonly effort?: string;
  };
  /**
   * Which tasks the leader audits: `risk` (the default) every task but the
   * low-risk ones, which their checks decide; `all` every task.
   */
  readonly leaderAudit?: "risk" | "all";
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
  /** Workers' progress and requests, decided by the run's orchestrator. */
  readonly coordinator: Coordinator;
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
    this.coordinator = new Coordinator(
      this.store,
      options.decideWork ??
        modelDecider(async () => {
          const planner = options.planner
            ? { choice: options.planner, provider: options.provider }
            : await this.#plannerChoice();
          return options.makeModel?.(planner.choice) ?? planner.provider.create(planner.choice);
        }),
      (note) => {
        options.onNote?.(note);
      },
    );
    this.pool = new WorkerPool({
      workerTools: (task, worker, context) =>
        coordinationTools(this.coordinator, context.runId, task.id, worker),
      provider: options.provider,
      ...(providers.length > 1 ? { providers } : {}),
      ...(this.registry ? { registry: this.registry } : {}),
      ...(options.providerFor ? { providerFor: options.providerFor } : {}),
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.affinity ? { affinity: options.affinity } : {}),
      ...(options.routing ? { routing: options.routing } : {}),
      ...(options.models && options.auto === true ? { models: options.models } : {}),
      // Minimum sufficient routing, unless the router is the fixed rules alone.
      ...((options.router ?? "learned") !== "rules"
        ? {
            sufficient: {
              mode: options.router === "shadow" ? ("shadow" as const) : ("learned" as const),
              attempts: () => this.#attempts(),
              ...(options.explore
                ? {
                    explore: {
                      share:
                        options.explore === true
                          ? EXPLORE_SHARE
                          : (options.explore.share ?? EXPLORE_SHARE),
                      random:
                        options.explore === true
                          ? Math.random
                          : (options.explore.random ?? Math.random),
                    },
                  }
                : {}),
            },
          }
        : {}),
      historyFor: (runId, taskId) => this.#history(runId, taskId),
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      // What models spent of their plans, from every recorded run; it grows as attempts end.
      costs: new CostBook(this.metrics?.attempts() ?? []),
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
            ...withSpawner(this.#sandboxFor(workspace.root)),
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
        runner: options.commandRunner ?? checksRunner((cwd) => this.#sandboxFor(cwd)),
      }),
      policy: this.policy,
      ...(options.ask ? { ask: options.ask } : {}),
      // A leader audits every task; without one, the cross review when it is on.
      ...(options.review || options.leader
        ? { review: this.#reviewing(options.review || true) }
        : {}),
      ...(options.delivery === "live"
        ? {
            onMerged: async (runId: string, taskId: string) => {
              const part = await deliverPart(
                { store: this.store, worktrees: this.worktrees, runId },
                taskId,
              );
              this.options.onDelivered?.({ task: taskId, lines: [describePart(part, taskId)] });
            },
          }
        : {}),
    });
  }

  /**
   * Phase D5: who reviews and how. The reviewer is routed as a review task
   * (the user's affinity: a deep Claude model), and recorded as independent
   * when its model differs from the worker's.
   */
  #reviewing(setting: true | { readonly rounds?: number; readonly kinds?: readonly TaskKind[] }) {
    const kinds = setting === true || !setting.kinds ? undefined : new Set(setting.kinds);
    const leading = this.options.leader !== undefined;
    return {
      // The leader audits every task; a cross review, every kind but docs.
      // The leader audits in proportion to risk (AGENT_LEADER_AUDIT): a low-risk task
      // whose checks passed (code, not a model) needs no extra model call; `all` audits each.
      for: (task: TaskRecord) =>
        leading
          ? this.options.leaderAudit === "all" || riskOf(task.spec) !== "low"
          : kinds
            ? kinds.has(task.spec.kind)
            : task.spec.kind !== "docs",
      ...(leading ? { leader: true } : {}),
      ask: async (task: TaskRecord, diff: string, context: AttemptContext, summary?: string) => {
        const leader = this.#leaderChoice();
        if (leader) {
          const model =
            this.options.makeModel?.(leader.choice) ?? leader.provider.create(leader.choice);
          const reviewer = plannerLabel(leader);
          const worker = this.store.task(context.runId, task.id)?.model ?? "";
          return {
            verdict: await crossReview(model, task.spec, diff, context.signal, {
              leader: true,
              ...(summary ? { summary } : {}),
            }),
            reviewer,
            independent: worker !== "" && !reviewer.endsWith(`/${worker}`) && worker !== reviewer,
          };
        }
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
  ): Promise<
    Planned & {
      routes: Map<string, Route>;
      planner: string;
      /** The run's leader, when it leads this run. */
      leader?: string;
      /** The leader chosen, when its provider is not one of this run's. */
      leaderMissing?: string;
    }
  > {
    await this.#billingAllowed();
    // The planner's model, made with the provider it was routed to.
    const planner = this.options.planner
      ? { choice: this.options.planner, provider: this.options.provider }
      : await this.#plannerChoice();
    const model =
      this.options.makeModel?.(planner.choice) ?? planner.provider.create(planner.choice);
    const leading = this.#leaderChoice();
    const planned = await makePlan(
      { request, context: await this.#projectContext() },
      {
        model,
        ...(signal ? { signal } : {}),
        ...(leading
          ? { leader: { name: plannerLabel(leading), roster: await this.#roster() } }
          : {}),
      },
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
    return {
      ...planned,
      routes,
      planner: plannerLabel(planner),
      ...(leading ? { leader: plannerLabel(leading) } : {}),
      ...(this.options.leader && !leading
        ? {
            leaderMissing: `${this.options.leader.provider}${this.options.leader.model ? `/${this.options.leader.model}` : ""}`,
          }
        : {}),
    };
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
      const delivering =
        (this.options.delivery ?? "manual") !== "manual" ||
        this.policy.action("merge-user").decision === "allow";
      if (state === "completed" && delivering) {
        // The work goes into the user's branch (phase D6), checked there as a whole.
        const delivered = await this.deliver(runId);
        this.options.onDelivered?.({
          lines: describeDelivery(delivered, this.worktrees.integrationBranch(runId)),
        });
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
          runner: this.options.commandRunner ?? checksRunner((cwd) => this.#sandboxFor(cwd)),
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
  /** Runs this orchestrator is driving: their attempts count as evidence as they end. */
  readonly #live = new Set<string>();
  #recorded: AttemptRecord[] | undefined;

  /** Every recorded attempt, with those of the runs going on now. */
  #attempts(): AttemptRecord[] {
    this.#recorded ??= this.metrics?.attempts() ?? [];
    const live = [...this.#live].flatMap(
      (id) => deriveRun(this.store, id, this.options.project.name).attempts,
    );
    return [...this.#recorded.filter((a) => !this.#live.has(a.run)), ...live];
  }

  /** A task's earlier attempts in its run, judged by code: for retries and escalation. */
  #history(runId: string, taskId: string): PriorAttempt[] {
    this.#live.add(runId);
    return deriveRun(this.store, runId, this.options.project.name)
      .attempts.filter((a) => a.task === taskId)
      .map((a) => ({
        model: a.model,
        ...(a.effort ? { effort: a.effort } : {}),
        verdict: judge(a),
        ...(a.failure ? { failure: a.failure } : {}),
        ...(a.quotaShare === undefined ? {} : { share: a.quotaShare }),
      }));
  }

  /** The decisions the router took in a run, in order, each with its candidates. */
  decisions(
    runId: string,
  ): { task: string; attempt: number; decision: Decision; applied: boolean }[] {
    return this.store
      .events(runId)
      .filter((e) => e.kind === "route_decision")
      .map((e) => ({
        task: e.taskId ?? "",
        attempt: Number(e.data.attempt ?? 1),
        decision: e.data as unknown as Decision,
        applied: e.data.applied === true,
      }));
  }

  /** What the run's workers reported and asked, and how each request was decided. */
  coordination(runId: string): string[] {
    return describeCoordination(this.store, runId);
  }

  /** A task's own folder (its worktree) and branch. */
  taskWhere(runId: string, taskId: string): { folder: string; branch: string } {
    return {
      folder: this.worktrees.pathFor(runId, taskId),
      branch: this.worktrees.branchFor(runId, taskId),
    };
  }

  /** Where the run's sub-agents work: one folder per task, each a git worktree of its own. */
  workFolder(runId: string): string {
    return dirname(this.worktrees.pathFor(runId, "_"));
  }

  /** How the run's work reaches the user's branch. */
  get deliveryMode(): Delivery_Mode {
    return this.options.delivery ?? "manual";
  }

  /** Where the work goes and how, in a line for a person, when a run starts. */
  describeWork(runId: string): string {
    const how =
      this.deliveryMode === "live"
        ? "each task's work comes into your folder as soon as it passes its checks, and everything is checked together at the end"
        : this.deliveryMode === "end"
          ? "the work comes into your folder when the run completes and its checks pass"
          : `the work stays on ${this.integrationBranch(runId)} until you merge it`;
    return `The sub-agents work in copies of the project under ${this.workFolder(runId)} (one per task); ${how}.`;
  }

  integrationBranch(runId: string): string {
    return this.worktrees.integrationBranch(runId);
  }

  /**
   * The sandbox of a worktree (or the project's folder): one each, made by
   * its first command, for the worker's commands and the task's checks. A
   * worktree may write its repository's git folder too (its commits). None
   * when the sandbox is off, or for a run given its own tools.
   */
  readonly #sandboxes = new Map<string, ReturnType<SandboxManager["spawner"]>>();
  #sandboxFor(folder: string): ReturnType<SandboxManager["spawner"]> | undefined {
    if (sandboxMode() === "off" || this.options.tools) return undefined;
    const root = [...this.#sandboxes.keys()].find(
      (k) => folder === k || folder.startsWith(`${k}/`) || folder.startsWith(`${k}\\`),
    );
    if (root) return this.#sandboxes.get(root);
    const git = join(this.options.projectRoot, ".git");
    const spawner = sandboxManager().spawner(() =>
      sandboxManager().create({
        label: folder === this.options.projectRoot ? "run" : `task ${basename(folder)}`,
        workspace: folder,
        ...(folder === this.options.projectRoot ? {} : { writable: [git] }),
      }),
    );
    this.#sandboxes.set(folder, spawner);
    return spawner;
  }

  /** Finishes the run's sandboxes (destroyed, or kept as AGENT_SANDBOX_KEEP says). */
  finishSandboxes(failed: boolean): void {
    for (const spawner of this.#sandboxes.values()) {
      const made = spawner.record();
      if (made) sandboxManager().finish(made.id, failed);
    }
    this.#sandboxes.clear();
  }

  close(): void {
    this.finishSandboxes(false);
    this.store.close();
    if (this.options.metrics === undefined) this.metrics?.close();
  }

  /** The run's leader, when one was chosen and its provider is one of the run's. */
  #leaderChoice(): { choice: ModelChoice; provider: Provider; model: string } | undefined {
    const leader = this.options.leader;
    if (!leader) return undefined;
    let provider: Provider;
    try {
      provider = this.pool.providerById(leader.provider);
    } catch {
      return undefined;
    }
    return {
      choice: {
        ...(leader.model && leader.model !== "default" ? { model: leader.model } : {}),
        ...(leader.effort ? { effort: leader.effort } : {}),
      },
      provider,
      model: leader.model ?? "default",
    };
  }

  /** Who the leader may give tasks to: each provider of the run, with its models. */
  async #roster(): Promise<string[]> {
    const providers = this.options.providers ?? [this.options.provider];
    return Promise.all(
      providers.map(async (p) => {
        const catalog = await this.pool.catalog(p.id).catch(() => undefined);
        const models = (catalog?.models ?? [])
          .filter((m) => m.id !== "default")
          .slice(0, 15)
          .map((m) => {
            const tier = catalog
              ? (["deep", "standard", "light"] as const).find((t) => catalog.tiers[t][0] === m.id)
              : undefined;
            return `${m.id}${tier ? ` (${tier})` : ""}${m.hint && /tools|context/.test(m.hint) ? ` [${m.hint}]` : ""}`;
          });
        return `${p.id}: ${models.length > 0 ? models.join(", ") : "its own choice of model"}`;
      }),
    );
  }

  async #plannerChoice(): Promise<{ choice: ModelChoice; provider: Provider; model: string }> {
    // The run's leader plans it.
    const leader = this.#leaderChoice();
    if (leader) return leader;
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
export function checksRunner(spawner?: (cwd: string) => Spawner | undefined): CommandRunner {
  return shellRunner({
    hiddenEnv: ["GRAFENO_AGENT_KEY", "GRAFENO_OWNER_TOKEN", ...PROVIDER_SECRET_ENV],
    ...(spawner ? { spawner } : {}),
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

/** How the run's work reaches the user's branch. */
export const DELIVERY_MODES = ["live", "end", "manual"] as const;
export type Delivery_Mode = (typeof DELIVERY_MODES)[number];

/** The delivery a setting asks for (`AGENT_DELIVERY`); `live` when unset or unknown. */
export function deliveryMode(setting: string | undefined): Delivery_Mode {
  const value = (setting ?? "").trim().toLowerCase();
  return (DELIVERY_MODES as readonly string[]).includes(value) ? (value as Delivery_Mode) : "live";
}

/** One task's delivery, in a line for a person. */
export function describePart(part: PartDelivery, taskId: string): string {
  switch (part.status) {
    case "delivered":
      return `${taskId}: its work is in your folder now (${part.branch}, ${part.commit.slice(0, 8)}).`;
    case "already":
      return `${taskId}: its work was already in your folder.`;
    case "skipped":
      return `${taskId}: not brought to your folder yet (${part.reason}); it is tried again with the next task and at the end.`;
  }
}
