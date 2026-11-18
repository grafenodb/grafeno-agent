import type {
  ConstraintEvent,
  NamespaceInfo,
  NamespaceStats,
  NodeWithText,
} from "@grafenodb/client";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { MemoryAdmin } from "../../src/app/memory-admin.js";
import { FakeModel } from "../../src/model/index.js";
import type { Plan } from "../../src/orchestrator/plan.js";
import { SqliteStore } from "../../src/orchestrator/store.js";
import type { Provider, ProviderStatus } from "../../src/providers/types.js";
import { connectionState } from "../../src/tui/adapters/providers.js";
import { runRows, taskFields } from "../../src/tui/adapters/runs.js";
import { ClickArea } from "../../src/tui/clicks.js";
import { InputArea } from "../../src/tui/core/input.js";
import { MemoryView } from "../../src/tui/views/memory.js";
import { ModelsView } from "../../src/tui/views/models.js";
import { ProvidersView } from "../../src/tui/views/providers.js";
import { RunsView } from "../../src/tui/views/runs.js";

const ESC = "\u001B";
const ENTER = "\r";
const DOWN = "\u001B[B";
const TAB = "\t";
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function area(tree: ReactNode) {
  return render(
    <InputArea>
      <ClickArea>{tree}</ClickArea>
    </InputArea>,
  );
}

type App = ReturnType<typeof render>;

async function keys(app: App, ...sequence: string[]): Promise<void> {
  for (const key of sequence) {
    app.stdin.write(key);
    await wait(40);
  }
}

async function until(app: App, check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}:\n${app.lastFrame() ?? ""}`);
    await wait(30);
  }
}

function provider(id: string, name: string, status: ProviderStatus | Error): Provider {
  return {
    id,
    name,
    signIn: "sign in",
    status: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)),
    models: () =>
      Promise.resolve([
        { id: "big", name: "Big 1" },
        { id: "small", name: "Small 1", hint: "fastest" },
      ]),
    efforts: () => [],
    usage: () => Promise.resolve(undefined),
    modelName: (m) => m,
    create: () => new FakeModel({ turns: [] }),
    tiers: { deep: ["big"], standard: ["big"], light: ["small"] },
  };
}

describe("a connection's state comes from what it answered, never from its settings alone", () => {
  const signedIn = { installed: true, signedIn: true, detail: "Ready." };
  it("available, configured, unavailable, error", () => {
    expect(connectionState({ id: "codex", status: signedIn, env: {} }).state).toBe("available");
    expect(
      connectionState({
        id: "codex",
        status: { installed: true, signedIn: false, detail: "Sign in." },
        env: {},
      }).state,
    ).toBe("configured");
    expect(
      connectionState({
        id: "codex",
        status: { installed: false, signedIn: false, detail: "No CLI." },
        env: {},
      }),
    ).toEqual({ state: "unavailable", why: "No CLI." });
    expect(
      connectionState({ id: "codex", status: signedIn, env: { PROVIDER_CODEX_ENABLED: "false" } }),
    ).toEqual({
      state: "unavailable",
      why: "switched off",
    });
    expect(connectionState({ id: "codex", failed: "spawn ENOENT", env: {} })).toEqual({
      state: "error",
      why: "spawn ENOENT",
    });
  });

  it("connected but held back: it bills per token and that is not allowed", () => {
    const metered = { ...signedIn, billing: { kind: "metered" as const, detail: "API key" } };
    expect(connectionState({ id: "claude-api", status: metered, env: {} }).state).toBe("connected");
    expect(
      connectionState({
        id: "claude-api",
        status: metered,
        env: { AGENT_ALLOW_BILLING: "claude-api" },
      }).state,
    ).toBe("available");
  });
});

describe("the providers window (/providers and each section of /connect)", () => {
  const list = () => [
    provider("codex", "Codex", {
      installed: true,
      signedIn: true,
      detail: "Ready.",
      version: "1.2",
    }),
    provider("gemini", "Gemini", { installed: true, signedIn: false, detail: "No key yet." }),
    provider("ollama", "Ollama", new Error("ECONNREFUSED")),
  ];

  it("lists each connection with its state and switches; Shift+F10 inspects one; use it for the chat", async () => {
    const used: string[] = [];
    const app = area(
      <ProvidersView
        providers={list()}
        current="gemini"
        autoMembers={["codex"]}
        onToggleAuto={() => undefined}
        onSwitch={() => ""}
        onUse={(p) => used.push(p.id)}
        onClose={() => undefined}
      />,
    );
    await until(app, () => !(app.lastFrame() ?? "").includes("asking"), "the states");
    const screen = app.lastFrame() ?? "";
    expect(screen).toMatch(/Codex\s+CLI\s+● available\s+\[ON \]\s+\[ON \]/);
    expect(screen).toMatch(/Gemini · in use\s+API key\s+○ configured\s+\[OFF\]/);
    expect(screen).toMatch(/Ollama\s+local\s+✗ error/);
    expect(screen).toContain("▸Auto");
    // Shift+F10 (or a right click): its details.
    await keys(app, "\u001B[21;2~");
    await until(app, () => (app.lastFrame() ?? "").includes("Connection · Codex"), "the inspector");
    expect(app.lastFrame()).toMatch(/Version\s+1\.2/);
    await keys(app, ENTER);
    expect(used).toEqual(["codex"]);
    app.unmount();
  });

  it("searches by name as it is typed; Space flips Auto, ←→ then Space flips On", async () => {
    const toggled: string[] = [];
    const switched: string[] = [];
    const app = area(
      <ProvidersView
        providers={list()}
        autoMembers={[]}
        onToggleAuto={(id) => toggled.push(id)}
        onSwitch={(id, on) => {
          switched.push(`${id} ${on ? "on" : "off"}`);
          return `${id} switched`;
        }}
        onUse={() => undefined}
        onClose={() => undefined}
      />,
    );
    await until(app, () => !(app.lastFrame() ?? "").includes("asking"), "the states");
    await keys(app, ..."gem".split(""));
    await until(app, () => (app.lastFrame() ?? "").includes("1 of 3"), "the search");
    expect(app.lastFrame()).not.toContain("Codex");
    await keys(app, " ");
    expect(toggled).toEqual(["gemini"]);
    await keys(app, "\u001B[C");
    expect(app.lastFrame()).toContain("▸On");
    await keys(app, " ");
    expect(switched).toEqual(["gemini off"]);
    // Esc clears the search first: everything again.
    await keys(app, ESC);
    await until(app, () => (app.lastFrame() ?? "").includes("Codex"), "every connection");
    app.unmount();
  });

  it("a connection with no key yet: Enter is where the key is typed", async () => {
    const keyed: string[] = [];
    const app = area(
      <ProvidersView
        providers={list()}
        autoMembers={[]}
        onToggleAuto={() => undefined}
        onSwitch={() => ""}
        onUse={() => undefined}
        needsKey={(_p, status) => !status.signedIn}
        onKey={(p) => keyed.push(p.id)}
        onClose={() => undefined}
      />,
    );
    await until(app, () => !(app.lastFrame() ?? "").includes("asking"), "the states");
    await keys(app, DOWN, ENTER);
    expect(keyed).toEqual(["gemini"]);
    app.unmount();
  });
});

describe("the models view", () => {
  it("says what is verified and what is not: a provider that does not say is unknown", async () => {
    const used: string[] = [];
    const app = area(
      <ModelsView
        provider={provider("codex", "Codex", { installed: true, signedIn: true, detail: "Ready." })}
        current="big"
        onUse={(id) => used.push(id)}
        onClose={() => undefined}
      />,
    );
    await until(app, () => (app.lastFrame() ?? "").includes("Small 1"), "the models");
    expect(app.lastFrame()).toMatch(/Big 1 · in use\s+deep\s+unknown\s+unknown\s+unknown/);
    expect(app.lastFrame()).toMatch(/Small 1\s+light/);
    await keys(app, DOWN, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Model · Small 1"), "the inspector");
    expect(app.lastFrame()).toContain("the provider does not say");
    await keys(app, ENTER);
    expect(used).toEqual(["small"]);
    app.unmount();
  });
});

function runStore() {
  const store = new SqliteStore();
  const plan: Plan = {
    goal: "g",
    risks: [],
    tasks: [
      {
        id: "api",
        title: "The API",
        description: "",
        kind: "backend",
        dependsOn: [],
        complexity: 2,
        capabilities: ["code"],
        touches: ["src/api.ts"],
        acceptance: [{ check: "command", run: "npm test" }],
        parallelSafe: true,
      },
    ],
  };
  const run = store.createRun("Build the API", plan, ["api"]);
  store.transition(run.id, "api", "ready");
  store.transition(run.id, "api", "running", { attempts: 1 });
  store.annotate(run.id, "api", { model: "codex/luna" });
  store.event(run.id, "route_decision", { reason: "the cheapest sufficient arm" }, "api");
  store.event(
    run.id,
    "attempt_metrics",
    { model: "codex/luna", outcome: "completed", ms: 41_000, inputTokens: 900, outputTokens: 80 },
    "api",
  );
  store.event(run.id, "verified", { ok: true }, "api");
  store.event(run.id, "attempt_ended", { attempt: 1, status: "completed" }, "api");
  store.transition(run.id, "api", "completed");
  store.setRunState(run.id, "completed");
  return { store, run };
}

describe("the runs view", () => {
  it("rows from what each run recorded; a task's attempts, and tool calls said as not kept", () => {
    const { store, run } = runStore();
    const rows = runRows(store);
    expect(rows.map((r) => r.id)).toEqual([run.id]);
    expect(rows[0]?.cells).toMatchObject({
      request: "Build the API",
      state: "completed",
      tasks: "1/1",
    });
    expect(rows[0]?.tone).toBe("success");
    const fields = taskFields(store, run.id, "api");
    expect(fields).toContainEqual({
      label: "Attempt 1",
      value: "codex/luna · completed · 41 s · 900 in / 80 out",
    });
    expect(fields).toContainEqual({ label: "Checks", value: "✓" });
    expect(fields).toContainEqual(
      expect.objectContaining({ label: "Routed", value: "the cheapest sufficient arm" }),
    );
    expect(fields).toContainEqual(expect.objectContaining({ label: "Tool calls" }));
  });

  it("Enter opens a run and its tasks, Enter a task's attempts, o opens it as before, Esc goes back", async () => {
    const { store, run } = runStore();
    const opened: string[] = [];
    let closed = 0;
    const app = area(
      <RunsView
        store={store}
        onOpen={(id) => opened.push(id)}
        onClose={() => {
          closed++;
        }}
      />,
    );
    await wait();
    expect(app.lastFrame()).toMatch(/Build the API\s+completed\s+1\/1/);
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes(`Run · ${run.id}`), "the run");
    expect(app.lastFrame()).toMatch(/The API\s+completed\s+1\s+codex\/luna/);
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Task · api"), "the task");
    expect(app.lastFrame()).toContain("Attempt 1");
    await keys(app, ESC, "o", ESC, ESC);
    expect(opened).toEqual([run.id]);
    expect(closed).toBe(1);
    app.unmount();
  });
});

/** A memory in a few calls, with what was done to it. */
function fakeAdmin(): MemoryAdmin & { done: string[] } {
  const done: string[] = [];
  const node = (id: string, name: string): NodeWithText => ({
    id,
    labels: ["Decision"],
    props: { name },
    sources: [],
    created_at: 1_700_000_000_000_000,
    updated_at: 1_700_000_000_000_000,
    memory: { importance: 0.8, accesses: 3 } as NodeWithText["memory"],
    text: `${name}, decided after the review.`,
  });
  const spaces: NamespaceInfo[] = [
    {
      name: "mpi",
      nodes: 128,
      edges: 300,
      created_at: 1_700_000_000_000_000,
      description: "the project",
    },
    { name: "old", nodes: 4, edges: 1, created_at: 1_600_000_000_000_000 },
  ];
  return {
    done,
    active: "mpi",
    namespaces: () => Promise.resolve(spaces),
    stats: (ns) =>
      Promise.resolve({
        name: ns,
        nodes: 4,
        edges: 1,
        node_labels: { Decision: 3, Fact: 1 },
        edge_labels: {},
        texts: 4,
        text_terms: 20,
        vectors: 0,
        vector_dimension: null,
      } satisfies NamespaceStats),
    search: (_ns, query) =>
      Promise.resolve([
        { id: "n1", title: `Use SQLite (${query})`, labels: ["Decision"], score: 1.5 },
      ]),
    node: (_ns, id) =>
      Promise.resolve({
        node: node(id, id === "n1" ? "Use SQLite" : "The store"),
        relations: [
          {
            label: "depends_on",
            direction: "out",
            other: { id: "n2", title: "The store" },
            ended: false,
          },
          {
            label: "replaced",
            direction: "in",
            other: { id: "n3", title: "Use JSON" },
            ended: true,
          },
        ],
      }),
    contradictions: () =>
      Promise.resolve([
        {
          constraint: "one_database",
          action: "invalidated",
          new_edge: "e2",
          old_edge: "e1",
          recorded_at: 1_700_000_000_000_000,
          by: "agent",
        } satisfies ConstraintEvent,
      ]),
    list: (_ns, options) =>
      Promise.resolve(
        options?.after
          ? { items: [{ id: "n9", title: "A later page", labels: ["Fact"], score: 0 }], next: null }
          : {
              items: [
                { id: "n1", title: "Use SQLite", labels: ["Decision"], score: 0 },
                ...(options?.kind === "Decision"
                  ? []
                  : [{ id: "n4", title: "Ana works on billing", labels: ["Fact"], score: 0 }]),
              ],
              next: options?.kind ? null : "n4",
            },
      ),
    forget: (_ns, id) => {
      done.push(`forget ${id}`);
      return Promise.resolve();
    },
    duplicates: () =>
      Promise.resolve([
        {
          a: { id: "n1", title: "Use SQLite" },
          b: { id: "n5", title: "SQLite is the store" },
          score: 0.93,
        },
      ]),
    merge: (_ns, keep, merge) => {
      done.push(`merge ${merge} into ${keep}`);
      return Promise.resolve({ undo: "m1" });
    },
    undoMerge: (_ns, undo) => {
      done.push(`undo ${undo}`);
      return Promise.resolve();
    },
    drop: (ns) => {
      done.push(`drop ${ns}`);
      return Promise.resolve();
    },
    empty: (ns) => {
      done.push(`empty ${ns}`);
      return Promise.resolve();
    },
    ensure: () => Promise.resolve(false),
  };
}

describe("the memory view", () => {
  it("searches the memory, opens a memory with its facts, and goes from one to another", async () => {
    const admin = fakeAdmin();
    const app = area(
      <MemoryView admin={admin} notice={() => undefined} onClose={() => undefined} />,
    );
    await wait();
    expect(app.lastFrame()).toContain(
      "memories: what was remembered · facts: the links between them",
    );
    await keys(app, TAB, ..."sqlite".split(""), ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Use SQLite (sqlite)"), "the results");
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Facts (2)"), "the memory");
    const screen = app.lastFrame() ?? "";
    expect(screen).toMatch(/Kinds\s+Decision/);
    expect(screen).toContain("→ depends_on The store");
    expect(screen).toMatch(/← replaced Use JSON\s+\(no longer holds\)/);
    await keys(app, ENTER);
    await until(
      app,
      () => (app.lastFrame() ?? "").match(/Memory\s+The store/) !== null,
      "the other memory",
    );
    app.unmount();
  });

  it("a namespace is emptied or deleted only once its name is typed; this session's comes back with the next message", async () => {
    const admin = fakeAdmin();
    const said: string[] = [];
    const app = area(
      <MemoryView admin={admin} notice={(text) => said.push(text)} onClose={() => undefined} />,
    );
    await wait();
    // Shift+Tab from the first tab: the last one.
    await keys(app, "\u001B[Z");
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("mpi · this session"),
      "the namespaces",
    );
    // This session's namespace: deleting it says it comes back; emptying it warns.
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Namespace · mpi"), "its inspector");
    await keys(app, "2");
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("Delete the namespace mpi?"),
      "the delete dialog",
    );
    expect(app.lastFrame()).toMatch(/made\s+(?:│\s*)*again/);
    await keys(app, ESC);
    await until(
      app,
      () => !(app.lastFrame() ?? "").includes("Delete the namespace mpi?"),
      "the dialog closed",
    );
    await keys(app, "1");
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("Empty the namespace mpi?"),
      "the dialog",
    );
    expect(app.lastFrame()).toMatch(/This\s+(?:│\s*)*session goes on with an empty memory/);
    await keys(app, ENTER, "m", "p", ENTER);
    expect(admin.done).toEqual([]);
    await keys(app, "i", ENTER);
    await until(app, () => admin.done.length > 0, "emptied");
    expect(admin.done).toEqual(["empty mpi"]);
    // Another one, deleted.
    await until(app, () => (app.lastFrame() ?? "").includes("old"), "the list again");
    await keys(app, DOWN, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Namespace · old"), "old's inspector");
    await keys(app, "2", "o", "l", "d", ENTER);
    await until(app, () => admin.done.length > 1, "deleted");
    expect(admin.done).toEqual(["empty mpi", "drop old"]);
    expect(said.at(-1)).toBe("The namespace old is deleted.");
    // The contradictions Grafeno recorded: the tab before.
    await keys(app, "\u001B[Z");
    await until(app, () => (app.lastFrame() ?? "").includes("one_database"), "the contradictions");
    expect(app.lastFrame()).toMatch(/one_database\s+invalidated/);
    app.unmount();
  }, 20_000);

  it("browses the memory without knowing a name: by kind, a page at a time; a memory is forgotten", async () => {
    const admin = fakeAdmin();
    const said: string[] = [];
    const app = area(
      <MemoryView admin={admin} notice={(text) => said.push(text)} onClose={() => undefined} />,
    );
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("Ana works on billing"),
      "the memories",
    );
    expect(app.lastFrame()).toContain("[all]");
    expect(app.lastFrame()).toContain("n more");
    await keys(app, "n");
    await until(app, () => (app.lastFrame() ?? "").includes("A later page"), "the next page");
    // → a kind: Decision only.
    await keys(app, "\u001B[C");
    await until(
      app,
      () => !(app.lastFrame() ?? "").includes("Ana works on billing"),
      "Decision only",
    );
    expect(app.lastFrame()).toContain("[Decision]");
    // Open it, then x: a dialog, and it is forgotten only on yes.
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("Facts (2)"), "the memory");
    await keys(app, "x");
    await until(app, () => (app.lastFrame() ?? "").includes("Forget “Use SQLite”?"), "the dialog");
    await keys(app, "n");
    expect(admin.done).toEqual([]);
    await keys(app, "x", "y");
    await until(app, () => admin.done.length > 0, "forgotten");
    expect(admin.done).toEqual(["forget n1"]);
    expect(said.at(-1)).toBe("Forgotten: Use SQLite.");
    app.unmount();
  });

  it("duplicates: merged by choosing which stays, undone with u; c asks the agent to consolidate", async () => {
    const admin = fakeAdmin();
    const asked: string[] = [];
    const app = area(
      <MemoryView
        admin={admin}
        notice={() => undefined}
        onAsk={(prompt) => asked.push(prompt)}
        onClose={() => undefined}
      />,
    );
    await wait();
    await keys(app, TAB, TAB);
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("SQLite is the store"),
      "the duplicates",
    );
    expect(app.lastFrame()).toMatch(/Use SQLite\s+SQLite is the store\s+0\.93/);
    await keys(app, ENTER);
    await until(app, () => (app.lastFrame() ?? "").includes("which memory stays"), "the choice");
    await keys(app, "1");
    await until(app, () => admin.done.length > 0, "merged");
    expect(admin.done).toEqual(["merge n5 into n1"]);
    await until(
      app,
      () => (app.lastFrame() ?? "").includes("u undo the last merge"),
      "undo offered",
    );
    await keys(app, "u");
    await until(app, () => admin.done.length > 1, "undone");
    expect(admin.done).toEqual(["merge n5 into n1", "undo m1"]);
    await keys(app, "c");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("consolidate the groups of old memories");
    app.unmount();
  });
});
