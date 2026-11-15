import { loadConfig } from "../config.js";
import { detectProject } from "../memory/project.js";
import { grafenoVault } from "../memory/vault.js";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/orchestrator.js";
import type { TaskKind } from "../orchestrator/plan.js";
import type { Planned } from "../orchestrator/planner.js";
import type { Autonomy } from "../orchestrator/policy.js";
import type { Route } from "../orchestrator/router.js";
import { chosenProviders } from "../providers/index.js";
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
  const config = loadConfig();
  await prepareGrafeno(config);
  await checkGrafeno(config);
  const cwd = settings.cwd ?? process.cwd();
  const project = detectProject(cwd, config.project);
  const embedder = await embedderFor(config.embedder, () => undefined);
  const light = settings.light === true;
  return new Orchestrator({
    ...providerOptions(settings),
    ...(settings.providerFor ? { providerFor: settings.providerFor } : {}),
    project,
    projectRoot: project.path ?? cwd,
    vault: grafenoVault(config),
    secrets: [config.agentKey, process.env.GRAFENO_OWNER_TOKEN ?? ""].filter(Boolean),
    mode: settings.mode ?? "controlled",
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
  if (!first) throw new Error("No provider is chosen: set AGENT_PROVIDERS");
  return providers.length > 1 ? { provider: first, providers } : { provider: first };
}

/** A plan, as lines for a person: each task, what it waits for, and the model it will get. */
export function describePlan(planned: Planned & { routes: Map<string, Route> }): string[] {
  const lines = [`Goal: ${planned.plan.goal}`, ""];
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
