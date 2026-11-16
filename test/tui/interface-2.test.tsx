import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Agent, CONTINUE_TURN } from "../../src/agent/agent.js";
import { ToolRegistry } from "../../src/agent/tools.js";
import { currentTimeTool } from "../../src/agent/builtin-tools.js";
import { FakeModel } from "../../src/model/index.js";
import { addProject, loadProjects, removeProject } from "../../src/projects.js";
import { describeAction, summarizeOutcome } from "../../src/tui/activity.js";
import { AgentsPanel } from "../../src/tui/agents-panel.js";
import { ProjectsPanel } from "../../src/tui/projects.js";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a long turn goes on by itself", () => {
  it("past the step limit, a bounded number of times, in the same conversation", async () => {
    const model = new FakeModel({
      turns: [
        [{ call: "current_time" }, { say: "a" }, { call: "current_time" }, { say: "b" }],
        [{ say: "Finished." }],
      ],
    });
    const agent = new Agent({
      model,
      system: "test",
      tools: new ToolRegistry([currentTimeTool()]),
      limits: { maxSteps: 2, continueRounds: 3 },
    });
    const turn = await agent.turn("go");
    expect(turn.result.stopReason).toBe("end_turn");
    expect(turn.result.text).toContain("Finished.");
    expect(model.conversations[0]?.messages).toEqual(["go", CONTINUE_TURN]);
    // Without rounds to go on, it stops as before.
    const stopping = new Agent({
      model: new FakeModel({
        turns: [[{ call: "current_time" }, { say: "a" }, { call: "current_time" }, { say: "b" }]],
      }),
      system: "test",
      tools: new ToolRegistry([currentTimeTool()]),
      limits: { maxSteps: 2 },
    });
    expect((await stopping.turn("go")).result.stopReason).toBe("max_steps");
  });
});

describe("what the chat shows of each action", () => {
  it("reads a tool call as a verb, a target and what came of it", () => {
    expect(describeAction("read_file", { path: "src/a.ts", offset: 10, limit: 20 })).toEqual({
      verb: "Read",
      target: "src/a.ts (lines 10–29)",
    });
    expect(describeAction("run_command", { command: "npm   test" })).toEqual({
      verb: "Run",
      target: "npm test",
    });
    expect(describeAction("multi_edit", { path: "a.ts", edits: [{}, {}] }).target).toBe(
      "a.ts (2 changes)",
    );
    expect(describeAction("recall", { query: "the parser" })).toEqual({
      verb: "Recall",
      target: "the parser",
    });
    expect(summarizeOutcome("read_file", "File a.ts, lines 1-50 of 120 (its…):", false)).toBe(
      "120 lines",
    );
    expect(summarizeOutcome("run_command", "Exit code 0. Output…", false)).toBe("ok");
    expect(summarizeOutcome("run_command", "Exit code 2. Output…", false)).toBe("exit 2");
    expect(summarizeOutcome("search_files", "Matches (…):\na.ts:1: x\nb.ts:2: y", false)).toBe(
      "2 matches",
    );
    expect(summarizeOutcome("write_file", "Not allowed: .env may hold secrets", true)).toBe(
      "not allowed: .env may hold secrets",
    );
  });
});

describe("the agents panel", () => {
  it("draws sub-agents as a tree under the orchestrator: task, model, state", async () => {
    const app = render(
      <AgentsPanel
        width={36}
        main={{ model: "Opus 5.5 · high", doing: "waiting for you", busy: false }}
        agents={[
          {
            id: "api",
            runId: "r",
            title: "Write the API",
            state: "running",
            doing: "thinking",
            model: "codex/gpt-6.1-terra",
            effort: "medium",
            lines: [],
          },
          { id: "docs", runId: "r", title: "Write the docs", state: "pending", lines: [] },
        ]}
        viewing={undefined}
      />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("Orchestrator");
    expect(screen).toMatch(/├─.*Write the API/);
    expect(screen).toContain("codex/gpt-6.1-terra · medium");
    expect(screen).toContain("thinking");
    expect(screen).toMatch(/└─.*Write the docs/);
    expect(screen).toContain("no model yet");
    app.unmount();
  });
});

describe("projects", () => {
  it("are a name and a folder; a new one gets its folder and git", () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-projects-"));
    try {
      const file = join(dir, "projects.json");
      const made = addProject(join(dir, "shop-api"), "shop-api", { file, create: true });
      expect(made.name).toBe("shop-api");
      expect(existsSync(join(dir, "shop-api", ".git"))).toBe(true);
      // The same folder is not added twice; a name is not used twice.
      expect(addProject(join(dir, "shop-api"), "other", { file })).toEqual(made);
      expect(() => addProject(dir, "Shop-API", { file })).toThrow(/named Shop-API already/);
      expect(() => addProject(join(dir, "nope"), "nope", { file })).toThrow(/does not exist/);
      expect(loadProjects(file).map((p) => p.name)).toEqual(["shop-api"]);
      expect(removeProject("shop-api", file)).toBe(true);
      expect(loadProjects(file)).toEqual([]);
      expect(existsSync(join(dir, "shop-api"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the panel opens a project, adds this folder, or makes a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-projects-"));
    try {
      const file = join(dir, "projects.json");
      addProject(dir, "here", { file, git: false });
      const opened: string[] = [];
      const app = render(
        <ProjectsPanel
          current={join(dir, "elsewhere")}
          file={file}
          onDone={(project) => {
            if (project) opened.push(project.name);
          }}
        />,
      );
      await wait();
      const screen = app.lastFrame() ?? "";
      expect(screen).toContain("+ New project");
      expect(screen).toContain("+ Add this folder");
      expect(screen).toContain("here");
      // Down past the two actions to the project, then enter.
      app.stdin.write("\u001B[B");
      await wait();
      app.stdin.write("\u001B[B");
      await wait();
      app.stdin.write("\r");
      await wait();
      expect(opened).toEqual(["here"]);
      app.unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deleting conversations", () => {
  it("the store deletes one for good; the panel asks first", async () => {
    const { SessionStore } = await import("../../src/sessions/store.js");
    const { SessionsPanel } = await import("../../src/tui/sessions.js");
    const dir = mkdtempSync(join(tmpdir(), "ga-sessions-"));
    try {
      const store = new SessionStore(dir);
      const one = store.create("shop");
      store.add(one, { kind: "user", text: "write the parser" });
      expect(store.list("shop")).toHaveLength(1);
      expect(store.remove("shop", "../escape")).toBe(false);
      const deleted: string[] = [];
      const app = render(
        <SessionsPanel
          sessions={[{ id: one.id, title: "write the parser", hint: "1 message" }]}
          onResume={() => undefined}
          onDelete={(row) => {
            deleted.push(row.id);
            store.remove("shop", row.id);
          }}
          onCancel={() => undefined}
        />,
      );
      await wait();
      expect(app.lastFrame()).toContain("[delete]");
      app.stdin.write("d");
      await wait();
      expect(app.lastFrame()).toContain("Delete “write the parser”? It cannot be undone");
      // n keeps it; d then y deletes it.
      app.stdin.write("n");
      await wait();
      expect(deleted).toEqual([]);
      app.stdin.write("d");
      await wait();
      app.stdin.write("y");
      await wait();
      expect(deleted).toEqual([one.id]);
      expect(store.list("shop")).toEqual([]);
      app.unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
