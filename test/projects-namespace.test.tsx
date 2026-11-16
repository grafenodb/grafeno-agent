import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrafenoError } from "@grafenodb/client";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { describeDeletion, namespaceDropper } from "../src/app/project-delete.js";
import { loadConfig, type Config } from "../src/config.js";
import {
  addProject,
  deleteProject,
  loadProjects,
  projectAt,
  projectFootprint,
  projectNamespace,
} from "../src/projects.js";
import { checkGrafeno } from "../src/startup.js";
import { ProjectsPanel } from "../src/tui/projects.js";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function temp(): string {
  return mkdtempSync(join(tmpdir(), "ga-ns-"));
}

describe("a namespace per project", () => {
  it("each project gets its own, under the shared one; old entries get theirs", () => {
    const dir = temp();
    try {
      const file = join(dir, "projects.json");
      expect(projectNamespace("grafeno-agent", "Tienda Ñandú API")).toBe(
        "grafeno-agent--tienda-nandu-api",
      );
      const a = addProject(join(dir, "a"), "shop api", {
        file,
        create: true,
        git: false,
        base: "ga",
      });
      const b = addProject(join(dir, "b"), "shop.api", {
        file,
        create: true,
        git: false,
        base: "ga",
      });
      expect(a.namespace).toBe("ga--shop-api");
      expect(b.namespace).toBe("ga--shop-api-2");
      // An entry kept before projects had namespaces gets the one it would get now.
      writeFileSync(file, JSON.stringify({ projects: [{ name: "old", path: dir, added: "" }] }));
      expect(loadProjects(file, "ga")[0]?.namespace).toBe("ga--old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a folder inside a project is in it (the deepest); others are outside any", () => {
    const dir = temp();
    try {
      const file = join(dir, "projects.json");
      addProject(join(dir, "outer"), "outer", { file, create: true, git: false, base: "ga" });
      addProject(join(dir, "outer", "inner"), "inner", {
        file,
        create: true,
        git: false,
        base: "ga",
      });
      mkdirSync(join(dir, "outer", "inner", "src"));
      expect(projectAt(join(dir, "outer", "inner", "src"), file, "ga")?.name).toBe("inner");
      expect(projectAt(join(dir, "outer"), file, "ga")?.name).toBe("outer");
      expect(projectAt(join(dir, "outer-2"), file, "ga")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessions in a project's folder use its namespace; outside, the shared one", () => {
    const dir = temp();
    try {
      const env = {
        GRAFENO_AGENT_CONFIG: join(dir, "config.env"),
        GRAFENO_AGENT_KEY: "gk_test_0123456789abcdef",
        GRAFENO_NAMESPACE: "ga",
      };
      const shop = addProject(join(dir, "shop"), "shop", {
        file: join(dir, "projects.json"),
        create: true,
        git: false,
        base: "ga",
      });
      const inside = loadConfig(env, join(shop.path, "src"));
      expect(inside.namespace).toBe("ga--shop");
      expect(inside.project).toBe("shop");
      expect(inside.projectEntry?.name).toBe("shop");
      const outside = loadConfig(env, dir);
      expect(outside.namespace).toBe("ga");
      expect(outside.projectEntry).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the first session of a project makes its namespace", async () => {
    const config: Config = {
      grafenoUrl: "http://grafeno.test:7810",
      agentKey: "gk_test_0123456789abcdef",
      namespace: "ga--shop",
      sharedNamespace: "ga",
      projectEntry: { name: "shop", path: "/work/shop" },
      model: "fake",
      embedder: "none",
      grafenoMode: "external",
      palace: "shared",
    };
    const made: unknown[] = [];
    const reply = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (path === "/health") return reply(200, { status: "ok", version: "0.3.0" });
      if (path === "/v1/namespaces" && init?.method === "POST") {
        made.push(JSON.parse(init.body as string));
        return reply(201, { name: "ga--shop" });
      }
      if (path.endsWith("/tools")) {
        return made.length === 0
          ? reply(404, { error: { code: "not_found", message: "no namespace ga--shop" } })
          : reply(200, { tools: [{ name: "recall", description: "", inputSchema: {} }] });
      }
      return reply(404, { error: { code: "not_found", message: path } });
    };
    const report = await checkGrafeno(config, { fetch });
    expect(report.tools).toEqual(["recall"]);
    expect(made).toEqual([expect.objectContaining({ name: "ga--shop" })]);
  });
});

describe("deleting a project", () => {
  function setUp() {
    const dir = temp();
    const file = join(dir, "projects.json");
    const sessionsDir = join(dir, "sessions");
    const dataDir = join(dir, "data");
    const project = addProject(join(dir, "shop"), "shop", {
      file,
      create: true,
      git: false,
      base: "ga",
    });
    mkdirSync(join(sessionsDir, "shop"), { recursive: true });
    writeFileSync(join(sessionsDir, "shop", "one.json"), "{}");
    writeFileSync(join(sessionsDir, "shop", "two.json"), "{}");
    mkdirSync(join(dataDir, "runs"), { recursive: true });
    writeFileSync(join(dataDir, "runs", "shop.db"), "");
    writeFileSync(join(dataDir, "runs", "shop.db-wal"), "");
    return { dir, file, sessionsDir, dataDir, project };
  }

  it("drops its namespace, its conversations and runs, and keeps its folder", async () => {
    const { dir, file, sessionsDir, dataDir, project } = setUp();
    try {
      expect(projectFootprint(project, { sessionsDir, dataDir })).toEqual({
        sessions: 2,
        runs: true,
      });
      const dropped: string[] = [];
      const result = await deleteProject("SHOP", {
        file,
        sessionsDir,
        dataDir,
        dropNamespace: (ns) => {
          dropped.push(ns);
          return Promise.resolve(true);
        },
      });
      expect(dropped).toEqual(["ga--shop"]);
      expect(result).toMatchObject({ namespace: "dropped", sessions: 2, runs: true });
      expect(existsSync(join(sessionsDir, "shop"))).toBe(false);
      expect(existsSync(join(dataDir, "runs", "shop.db"))).toBe(false);
      expect(existsSync(join(dataDir, "runs", "shop.db-wal"))).toBe(false);
      expect(loadProjects(file)).toEqual([]);
      expect(existsSync(project.path)).toBe(true);
      expect(describeDeletion(result)).toContain('namespace "ga--shop" dropped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("when the namespace cannot be dropped, nothing else is touched", async () => {
    const { dir, file, sessionsDir, dataDir } = setUp();
    try {
      const result = await deleteProject("shop", {
        file,
        sessionsDir,
        dataDir,
        dropNamespace: () => Promise.reject(new Error("forbidden")),
      });
      expect(result.namespace).toEqual({ failed: "forbidden" });
      expect(existsSync(join(sessionsDir, "shop", "one.json"))).toBe(true);
      expect(existsSync(join(dataDir, "runs", "shop.db"))).toBe(true);
      expect(loadProjects(file).map((p) => p.name)).toEqual(["shop"]);
      expect(describeDeletion(result)).toContain("was not deleted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a namespace never made is not an error", async () => {
    const missing = new GrafenoError(404, "not_found", "no such namespace");
    const drop = namespaceDropper({ dropNamespace: () => Promise.reject(missing) });
    await expect(drop("ga--x")).resolves.toBe(false);
    const ok = namespaceDropper({ dropNamespace: () => Promise.resolve({ nodes: 1, edges: 0 }) });
    await expect(ok("ga--x")).resolves.toBe(true);
    const denied = new GrafenoError(403, "forbidden", "no");
    const fails = namespaceDropper({ dropNamespace: () => Promise.reject(denied) });
    await expect(fails("ga--x")).rejects.toBe(denied);
  });

  it("the panel asks first, naming the namespace, and never offers the open project", async () => {
    const { dir, file } = setUp();
    try {
      addProject(join(dir, "open"), "open", { file, create: true, git: false, base: "ga" });
      const deleted: string[] = [];
      const messages: string[] = [];
      const app = render(
        <ProjectsPanel
          current={join(dir, "open")}
          file={file}
          footprint={() => ({ sessions: 2, runs: true })}
          onDelete={(project) => {
            deleted.push(project.name);
            return Promise.resolve(`Deleted ${project.name}.`);
          }}
          onDone={(_project, message) => {
            if (message) messages.push(message);
          }}
        />,
      );
      await wait();
      expect(app.lastFrame()).toContain("Delete a project");
      // + New project, shop, open (where it starts), − Delete a project.
      app.stdin.write("\u001B[B");
      await wait();
      app.stdin.write("\r");
      await wait();
      const picker = app.lastFrame() ?? "";
      expect(picker).toContain("Delete which project");
      expect(picker).toContain("shop");
      expect(picker).not.toMatch(/\bopen\b.*ga--open/);
      app.stdin.write("\r");
      await wait();
      const asking = app.lastFrame() ?? "";
      expect(asking).toContain("ga--shop");
      expect(asking).toContain("2 conversations");
      expect(deleted).toEqual([]);
      app.stdin.write("y");
      await wait();
      expect(deleted).toEqual(["shop"]);
      expect(messages).toEqual(["Deleted shop."]);
      app.unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
