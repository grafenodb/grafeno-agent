/**
 * Workers sharing memory through a real Grafeno (in memory), on the fake
 * model: no plan usage.
 *
 *   npm run eval:orchestration
 *
 * A run of four tasks: contracts → (api, ui at the same time) → docs. The
 * architecture worker stores a decision; the two workers after it are given
 * it and store facts at the same time; the docs worker is given both. It
 * checks, in Grafeno, who stored what (the key, and each worker as author),
 * the per-task checkpoints, the palace, and that no operational state went
 * into memory.
 */
import { randomUUID } from "node:crypto";
import { Grafeno } from "@grafenodb/client";
import type { Config } from "../../src/config.js";
import { grafenoVault } from "../../src/memory/vault.js";
import { FakeModel } from "../../src/model/index.js";
import { workerMemory } from "../../src/orchestrator/memory.js";
import type { Plan, TaskSpec } from "../../src/orchestrator/plan.js";
import { Scheduler } from "../../src/orchestrator/scheduler.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import { WorkerPool } from "../../src/orchestrator/workers.js";
import type { Provider } from "../../src/providers/types.js";
import { Workspace } from "../../src/tools/workspace.js";
import { startGrafeno } from "./grafeno-server.js";

const OWNER = `owner-${randomUUID()}`;
const NAMESPACE = "orchestration";
const PROJECT = { name: "shop" };

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function spec(id: string, kind: TaskSpec["kind"], dependsOn: string[] = []): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}.`,
    kind,
    dependsOn,
    complexity: 2,
    capabilities: ["code"],
    touches: [`src/${id}.ts`],
    acceptance: [{ check: "command", run: "npm test" }],
    parallelSafe: true,
  };
}

const DECISION = "Orders have a status: open, paid or shipped; amounts are integer cents.";
const FACTS: Record<string, string> = {
  api: "The orders API exposes GET /orders and POST /orders/:id/pay.",
  ui: "The orders screen shows the status as a coloured badge.",
};

async function main(): Promise<void> {
  const grafeno = await startGrafeno({ ownerToken: OWNER });
  try {
    const owner = new Grafeno({ url: grafeno.url, token: OWNER });
    const { secret } = await owner.createKey({
      name: "grafeno-agent",
      grants: [{ namespace: NAMESPACE, role: "write" }],
    });
    const config: Config = {
      grafenoMode: "external",
      grafenoUrl: grafeno.url,
      agentKey: secret,
      namespace: NAMESPACE,
      model: "fake",
      embedder: "none",
      palace: "shared",
    };
    const vault = grafenoVault(config);
    const data = async (name: string, args: Record<string, unknown>) => {
      const answer = await vault.call(name, args);
      return (answer.data ?? JSON.parse(answer.text)) as Record<string, unknown>;
    };

    const systems = new Map<string, string>();
    let writingAtOnce = 0;
    let most = 0;
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      signIn: "",
      tiers: { deep: ["m"], standard: ["m"], light: ["m"] },
      status: () => Promise.resolve({ installed: true, signedIn: true, detail: "" }),
      models: () => Promise.resolve([{ id: "m", name: "M" }]),
      efforts: () => [],
      usage: () => Promise.resolve(undefined),
      modelName: (id) => id,
      create: () =>
        new FakeModel({
          turns: [
            (context) => {
              const id = /# Task (\S+)/.exec(context.message)?.[1] ?? "?";
              systems.set(id, context.system);
              if (id === "contracts") {
                return [
                  {
                    call: "remember",
                    input: { text: DECISION, labels: ["Decision"], name: "Order contract" },
                  },
                  { say: "Contracts decided." },
                ];
              }
              const fact = FACTS[id];
              if (fact) {
                writingAtOnce++;
                most = Math.max(most, writingAtOnce);
                return [
                  { wait: 80 },
                  { call: "remember", input: { text: fact, labels: ["Fact"] } },
                  {
                    say: () => {
                      writingAtOnce--;
                      return `${id} done.`;
                    },
                  },
                ];
              }
              return [{ say: "Docs written." }];
            },
          ],
        }),
    };

    const store = new SqliteStore();
    const tasks = [
      spec("contracts", "architecture"),
      spec("api", "backend", ["contracts"]),
      spec("ui", "frontend", ["contracts"]),
      spec("docs", "docs", ["api", "ui"]),
    ];
    const plan: Plan = { goal: "An orders feature", risks: [], tasks };
    const run = store.createRun(
      "Build orders",
      plan,
      tasks.map((t) => t.id),
    );
    const pool = new WorkerPool({
      provider,
      workspaceFor: () => Promise.resolve(new Workspace(process.cwd())),
      tools: () => [],
      memoryFor: workerMemory({ vault, project: PROJECT, knownSecrets: [secret] }),
    });

    console.log("A run of four tasks, two of them at once, sharing memory through Grafeno");
    check(
      (await new Scheduler({ store, runner: pool, maxWorkers: 3 }).run(run.id)) === "completed",
      "the run completes",
    );
    check(most === 2, "api and ui stored their facts at the same time");
    check(
      (systems.get("api") ?? "").includes(DECISION),
      "the api worker was given the architecture decision",
    );
    check((systems.get("ui") ?? "").includes(DECISION), "the ui worker was given it too");
    const docs = systems.get("docs") ?? "";
    check(
      docs.includes(FACTS.api ?? "") && docs.includes(FACTS.ui ?? ""),
      "the docs worker was given what api and ui stored",
    );
    check(!docs.includes("Do contracts."), "no worker is given another task's description");

    console.log("In Grafeno: who stored what");
    const notes = store.events(run.id).filter((e) => e.kind === "memories");
    const ids = notes.flatMap((e) => (Array.isArray(e.data.ids) ? e.data.ids.map(String) : []));
    check(ids.length === 3, "three memories were stored, and the run knows them by id");
    let attributed = 0;
    for (const id of ids) {
      const node = await data("get_node", { id });
      const by = (node.provenance as { recorded_by?: string } | undefined)?.recorded_by;
      const author = (node.props as { author?: string } | undefined)?.author ?? "";
      if (by === "grafeno-agent" && /^worker-.+-(contracts|api|ui)-1$/.test(author)) attributed++;
    }
    check(attributed === 3, "each is recorded by the agent's key, with its worker as author");

    for (const task of ["contracts", "api", "ui", "docs"]) {
      const resumed = await data("resume", { task: `${run.id}: ${task}` });
      const agent = (resumed.checkpoint as { agent?: string } | undefined)?.agent ?? "";
      check(
        new RegExp(`-${task}-1$`).test(agent),
        `the ${task} task saved a checkpoint under its worker`,
      );
    }

    const room = JSON.stringify(
      await data("palace_map", { palace: PROJECT.name, room: "General" }),
    );
    check(
      room.includes("Order contract") && room.includes("GET /orders"),
      "the memories are in the project's palace",
    );

    const operational = await data("recall", {
      query: "pending ready running task attempt",
      labels: ["Task", "Run"],
      limit: 5,
      depth: 0,
    });
    check(
      ((operational.results as unknown[] | undefined) ?? []).length === 0,
      "no operational state went into memory",
    );
    store.close();
  } finally {
    await grafeno.stop();
  }
  if (failures.length > 0) {
    console.error(
      `\n${String(failures.length)} failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("\nShared memory: all checks passed.");
  }
}

await main();
