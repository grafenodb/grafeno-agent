import { deliveryMode } from "../orchestrator/orchestrator.js";
import { routingMode } from "../orchestrator/router.js";
import { loadConfig } from "../config.js";
import { detectProject } from "../memory/project.js";
import { grafenoVault } from "../memory/vault.js";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/orchestrator.js";
import { exploreOn, routerMode } from "../orchestrator/learned.js";
import type { RunLimits } from "../orchestrator/limits.js";
import { TASK_KINDS, type TaskKind } from "../orchestrator/plan.js";
import type { Planned } from "../orchestrator/planner.js";
import type { Autonomy } from "../orchestrator/policy.js";
import type { Route } from "../orchestrator/router.js";
import { affinityFor, autoModels, chosenProviders, isAuto } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import { checkGrafeno } from "../startup.js";
import { embedderFor, prepareGrafeno } from "./services.js";

export interface OrchestrateSettings {
  readonly mode?: Autonomy;
  readonly workers?: number;
  /** Every task on the light tier at low effort, the planner too: the cheapest run. */
  readonly light?: boolean;
  readonly provider?: Provider;
  /** Tasks of these kinds go to this provider, when it is ready. */
  readonly providerFor?: Partial<Record<TaskKind, string>>;
  /** The providers, in order of preference; default: AGENT_PROVIDERS. */
  readonly providers?: readonly Provider[];
  /**
   * General Auto: every ready provider as one pool, with affinities by task
   * kind; default: AGENT_PROVIDERS=auto.
   */
  readonly auto?: boolean;
  /** Limits for the whole run (phase D2). */
  readonly limits?: RunLimits;
  /** Cross review (phase D5): a reviewer on another model may send tasks back. */
  readonly review?: boolean;
  readonly cwd?: string;
}

/**
 * An orchestrator on the user's settings: their Grafeno (memory), their
 * provider, the project of the folder it runs in.
 */
export async function createOrchestrator(
  settings: OrchestrateSettings,
  extra: Partial<OrchestratorOptions> = {},
): Promise<Orchestrator> {
  const config = await prepareGrafeno(loadConfig());
  await checkGrafeno(config);
  const cwd = settings.cwd ?? process.cwd();
  const project = detectProject(cwd, config.project);
  const embedder = await embedderFor(config.embedder, () => undefined);
  const light = settings.light === true;
  return new Orchestrator({
    ...providerOptions(settings),
    ...(settings.providerFor ? { providerFor: settings.providerFor } : {}),
    router: routerMode(process.env.AGENT_ROUTER),
    ...(settings.limits ? { limits: settings.limits } : {}),
    ...(settings.review ? { review: true } : {}),
    explore: exploreOn(process.env.AGENT_ROUTER_EXPLORE),
    ...((settings.auto ?? isAuto(process.env.AGENT_PROVIDERS))
      ? { auto: true, affinity: affinityFor(process.env.AGENT_AFFINITY, TASK_KINDS) }
      : {}),
    project,
    projectRoot: project.path ?? cwd,
    vault: grafenoVault(config),
    secrets: [config.agentKey, process.env.GRAFENO_OWNER_TOKEN ?? ""].filter(Boolean),
    mode: settings.mode ?? "controlled",
    routing: routingMode(process.env.AGENT_ROUTING),
    delivery: deliveryMode(process.env.AGENT_DELIVERY),
    models: autoModels(),
    maxWorkers: settings.workers ?? 3,
    ...(embedder ? { embedder } : {}),
    ...(light
      ? {
          profiles: Object.fromEntries(
            [
              "architecture",
              "backend",
              "debug",
              "frontend",
              "refactor",
              "review",
              "tests",
              "docs",
            ].map((kind) => [kind, { tier: "light", effort: "low" }]),
          ),
        }
      : {}),
    ...extra,
  });
}

/** The provider (phase A) or providers (phase B) of a run, from the settings. */
function providerOptions(settings: OrchestrateSettings): {
  provider: Provider;
  providers?: readonly Provider[];
} {
  if (settings.provider && !settings.providers) return { provider: settings.provider };
  const providers = settings.providers ?? chosenProviders();
  const first = providers[0];
  if (!first) {
    throw new Error(
      isAuto(process.env.AGENT_PROVIDERS)
        ? "Auto includes no provider yet: choose them in /connect (space marks one), or set AGENT_AUTO_PROVIDERS."
        : "No provider is chosen: set AGENT_PROVIDERS",
    );
  }
  return providers.length > 1 ? { provider: first, providers } : { provider: first };
}

/** A plan, as lines for a person: each task, what it waits for, and the model it will get. */
export function describePlan(
  planned: Planned & { routes: Map<string, Route>; planner?: string },
): string[] {
  const lines = [
    `Goal: ${planned.plan.goal}`,
    ...(planned.planner ? [`Planned by ${planned.planner}`] : []),
    "",
  ];
  // With tasks on more than one provider, each model is named with its provider.
  const providerOf = (route: Route | undefined) =>
    route?.kind === "run" && "provider" in route && typeof route.provider === "string"
      ? route.provider
      : undefined;
  const providers = new Set([...planned.routes.values()].map(providerOf).filter(Boolean));
  for (const id of planned.order) {
    const task = planned.plan.tasks.find((t) => t.id === id);
    if (!task) continue;
    const route = planned.routes.get(id);
    const prefix = providers.size > 1 && providerOf(route) ? `${String(providerOf(route))}/` : "";
    const model =
      route?.kind === "run"
        ? `${prefix}${route.model}${route.effort ? ` · ${route.effort}` : ""}`
        : route
          ? `held: ${route.reason}`
          : "";
    const waits = task.dependsOn.length > 0 ? `  after ${task.dependsOn.join(", ")}` : "";
    lines.push(`  ${task.id.padEnd(22)} ${task.kind.padEnd(12)} ${model.padEnd(18)}${waits}`);
    lines.push(`  ${" ".repeat(22)} ${task.title}`);
  }
  if (planned.plan.risks.length > 0) lines.push("", `Risks: ${planned.plan.risks.join("; ")}`);
  return lines;
}
