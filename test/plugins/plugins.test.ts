import { describe, expect, it } from "vitest";
import { permissionOf, type Tool } from "../../src/agent/tools.js";
import { pluginsCommand } from "../../src/app/plugins-command.js";
import { apiPermission, COMMON_NEVER } from "../../src/plugins/common.js";
import { githubPlugin, githubTools } from "../../src/plugins/github.js";
import { gitlabPlugin, gitlabTools } from "../../src/plugins/gitlab.js";
import { connectPlugins, enabledPluginIds } from "../../src/plugins/index.js";
import { parseRemote } from "../../src/plugins/repo.js";
import { cliTransport, parseIncluded, type RunResult } from "../../src/plugins/transport.js";
import type { ApiResponse, ApiTransport, Plugin } from "../../src/plugins/types.js";

const signal = new AbortController().signal;

/** A transport that answers from a table, and records what was asked. */
function fakeTransport(answers: Record<string, unknown>): ApiTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request(method, path, body) {
      calls.push(`${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`);
      const key = Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k));
      const data = key === undefined ? { message: "Not Found" } : answers[key];
      const response: ApiResponse = {
        status: key === undefined ? 404 : 200,
        data,
        text: JSON.stringify(data),
      };
      return Promise.resolve(response);
    },
  };
}

const byName = (tools: Tool[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

describe("plugin plumbing", () => {
  it("reads git remotes over https and ssh, nested GitLab groups too", () => {
    expect(parseRemote("https://github.com/grafenodb/grafeno.git")).toEqual({
      host: "github.com",
      path: "grafenodb/grafeno",
    });
    expect(parseRemote("git@github.com:grafenodb/grafeno-agent.git")).toEqual({
      host: "github.com",
      path: "grafenodb/grafeno-agent",
    });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/team/sub/app.git")).toEqual({
      host: "gitlab.example.com",
      path: "team/sub/app",
    });
    expect(parseRemote("/a/local/path")).toBeUndefined();
  });

  it("reads the CLI's answer with its status, and passes the body on stdin, never a shell", async () => {
    expect(
      parseIncluded('HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":1}'),
    ).toEqual({
      status: 201,
      data: { id: 1 },
      text: '{"id":1}',
    });
    const seen: { program: string; args: readonly string[]; input?: string }[] = [];
    const transport = cliTransport("gh", {
      run: (program, args, input) => {
        seen.push({ program, args, ...(input === undefined ? {} : { input }) });
        const result: RunResult = { code: 0, stdout: 'HTTP/2.0 200 OK\n\n{"ok":true}', stderr: "" };
        return Promise.resolve(result);
      },
    });
    const answer = await transport.request("POST", "/repos/a/b/issues", { title: "t" });
    expect(answer.data).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      program: "gh",
      args: ["api", "--method", "POST", "--include", "--input", "-", "repos/a/b/issues"],
      input: '{"title":"t"}',
    });
  });

  it("raw API calls: reading runs, changing asks, secrets and deleting a repository never", () => {
    const rules = [
      ...COMMON_NEVER,
      { method: /^DELETE$/, path: /^\/repos\/[^/]+\/[^/]+\/?$/, reason: "whole repository" },
    ];
    expect(apiPermission("GET", "repos/a/b/releases", rules, "GitHub").permission).toBe("free");
    expect(apiPermission("POST", "repos/a/b/releases", rules, "GitHub").permission).toBe("ask");
    expect(apiPermission("GET", "repos/a/b/actions/secrets", rules, "GitHub").permission).toBe(
      "never",
    );
    expect(apiPermission("GET", "projects/1/variables", rules, "GitLab").permission).toBe("never");
    expect(apiPermission("DELETE", "repos/a/b", rules, "GitHub").permission).toBe("never");
    expect(apiPermission("DELETE", "repos/a/b/issues/comments/1", rules, "GitHub").permission).toBe(
      "ask",
    );
    expect(apiPermission("PATCH", "user", rules, "GitHub").permission).toBe("never");
    expect(apiPermission("GET", "https://evil.example/x", rules, "GitHub").permission).toBe(
      "never",
    );
    expect(apiPermission("GET", "repos/../x", rules, "GitHub").permission).toBe("never");
  });
});

describe("GitHub", () => {
  it("reads issues and pull requests freely, and asks before opening or commenting", async () => {
    const transport = fakeTransport({
      "GET repos/o/r/issues?": [
        {
          number: 1,
          state: "open",
          title: "Bug",
          user: { login: "ana" },
          labels: [{ name: "bug" }],
        },
        { number: 2, state: "open", title: "A PR", user: { login: "ana" }, pull_request: {} },
      ],
      "GET repos/o/r/pulls/7/files": [
        { status: "modified", filename: "a.ts", additions: 3, deletions: 1 },
      ],
      "GET repos/o/r/pulls/7": {
        number: 7,
        state: "open",
        title: "Feature",
        head: { ref: "feat", sha: "abc" },
        base: { ref: "main" },
        user: { login: "ana" },
        mergeable: true,
      },
      "GET repos/o/r/commits/abc/check-runs": {
        check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
      },
      "POST repos/o/r/issues": { number: 9, html_url: "https://github.com/o/r/issues/9" },
    });
    const tools = byName(githubTools(transport, { root: "." }));
    const issues = await (tools.github_list_issues as Tool).run({ repo: "o/r" }, { signal });
    expect(issues).toContain("#1 [open] Bug — ana (bug)");
    expect(issues).not.toContain("A PR");
    const pr = await (tools.github_get_pr as Tool).run({ repo: "o/r", number: 7 }, { signal });
    expect(pr).toContain("feat → main");
    expect(pr).toContain("modified a.ts +3 -1");
    expect(pr).toContain("ci: completed / success");
    expect(permissionOf(tools.github_list_issues as Tool, {}).permission).toBe("free");
    expect(permissionOf(tools.github_create_issue as Tool, {}).permission).toBe("ask");
    expect(permissionOf(tools.github_comment as Tool, {}).permission).toBe("ask");
    expect(permissionOf(tools.github_create_pr as Tool, {}).permission).toBe("ask");
    expect(
      await (tools.github_create_issue as Tool).run({ repo: "o/r", title: "New" }, { signal }),
    ).toBe("Opened #9: https://github.com/o/r/issues/9");
    await expect(
      (tools.github_repo as Tool).run({ repo: "not a repo" }, { signal }),
    ).rejects.toThrow(/owner\/name/);
  });

  it("connects through gh's own sign-in first, never reading its token", async () => {
    const runs: string[] = [];
    const plugin = githubPlugin({
      env: {},
      run: (program, args) => {
        runs.push(`${program} ${args.join(" ")}`);
        return Promise.resolve(
          args[0] === "auth"
            ? { code: 0, stdout: "", stderr: "Logged in" }
            : { code: 0, stdout: 'HTTP/2.0 200 OK\n\n{"login":"ana"}', stderr: "" },
        );
      },
    });
    const status = await plugin.status();
    expect(status).toMatchObject({ ready: true, via: "cli", account: "ana" });
    expect(runs.some((r) => r.includes("auth token"))).toBe(false);
  });

  it("uses a token you made when gh is not signed in, and says when GitHub refuses it", async () => {
    const notSigned = () => Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" });
    const accepted = githubPlugin({
      env: { GITHUB_TOKEN: "ghp_test_token_value" },
      run: notSigned,
      fetch: (_url, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        return Promise.resolve(
          new Response(
            JSON.stringify({ login: auth === "Bearer ghp_test_token_value" ? "ana" : "?" }),
            { status: 200 },
          ),
        );
      },
    });
    expect(await accepted.status()).toMatchObject({ ready: true, via: "token", account: "ana" });
    const refused = githubPlugin({
      env: { GITHUB_TOKEN: "bad" },
      run: notSigned,
      fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
    });
    expect((await refused.status()).detail).toContain("refused the token (401)");
    const nothing = githubPlugin({ env: {}, run: () => Promise.reject(new Error("ENOENT")) });
    expect(await nothing.status()).toMatchObject({ ready: false });
    expect(await nothing.tools({ root: "." })).toEqual([]);
  });
});

describe("GitLab", () => {
  it("reads merge requests and pipelines, and asks before opening a merge request", async () => {
    const transport = fakeTransport({
      "GET projects/team%2Fapp/merge_requests?": [
        { iid: 3, state: "opened", title: "Add login", author: { username: "ana" }, labels: [] },
      ],
      "GET projects/team%2Fapp/pipelines?": [
        { id: 50, status: "failed", ref: "main", sha: "abcdef123", created_at: "2026-11-15T10:00" },
      ],
      "GET projects/team%2Fapp/pipelines/50/jobs": [
        { stage: "test", name: "unit", status: "failed" },
      ],
      "GET projects/team%2Fapp": { default_branch: "main" },
      "POST projects/team%2Fapp/merge_requests": {
        iid: 4,
        web_url: "https://gitlab.com/team/app/-/merge_requests/4",
      },
    });
    const tools = byName(gitlabTools(transport, { root: "." }));
    expect(
      await (tools.gitlab_list_mrs as Tool).run({ project: "team/app" }, { signal }),
    ).toContain("!3 [opened] Add login — ana");
    const pipelines = await (tools.gitlab_pipelines as Tool).run(
      { project: "team/app" },
      { signal },
    );
    expect(pipelines).toContain("50 failed on main");
    expect(pipelines).toContain("test / unit: failed");
    expect(permissionOf(tools.gitlab_create_mr as Tool, {}).permission).toBe("ask");
    expect(
      await (tools.gitlab_create_mr as Tool).run(
        { project: "team/app", title: "X", source_branch: "x", draft: true },
        { signal },
      ),
    ).toContain("Opened !4");
    expect(transport.calls.at(-1)).toContain(
      '"title":"Draft: X","source_branch":"x","target_branch":"main"',
    );
    expect(
      permissionOf(tools.gitlab_api as Tool, { method: "DELETE", path: "projects/team%2Fapp" })
        .permission,
    ).toBe("never");
  });

  it("works with a GitLab of your own (GITLAB_HOST) and its token", async () => {
    const asked: string[] = [];
    const plugin = gitlabPlugin({
      env: { GITLAB_HOST: "https://git.example.com/", GITLAB_TOKEN: "glpat-test" },
      run: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      fetch: (url, init) => {
        asked.push(
          `${url instanceof Request ? url.url : url.toString()} ${new Headers(init?.headers).get("private-token") ?? ""}`,
        );
        return Promise.resolve(new Response(JSON.stringify({ username: "ana" }), { status: 200 }));
      },
    });
    expect(await plugin.status()).toMatchObject({
      ready: true,
      via: "token",
      host: "git.example.com",
      account: "ana",
    });
    expect(asked).toEqual(["https://git.example.com/api/v4/user glpat-test"]);
  });
});

describe("turning plugins on and off", () => {
  const fake = (id: string, ready: boolean): Plugin => ({
    id,
    name: id === "github" ? "GitHub" : "GitLab",
    description: "d",
    terms: ["Under the service's terms."],
    connect: "Sign in.",
    status: () =>
      Promise.resolve({ ready, host: "h", detail: ready ? "Connected." : "Not connected." }),
    tools: () =>
      Promise.resolve([
        {
          name: `${id}_x`,
          description: "x",
          inputSchema: { type: "object" },
          writes: false,
          run: () => "x",
        },
      ]),
  });

  it("are off until turned on, each checked first", async () => {
    const env: Record<string, string | undefined> = {};
    const saved: Record<string, string>[] = [];
    const lines: string[] = [];
    const options = {
      env,
      say: (line: string) => lines.push(line),
      save: (values: Record<string, string>) => saved.push(values),
      make: (id: string) => fake(id, id === "github"),
    };
    expect(enabledPluginIds(env)).toEqual([]);
    expect(await pluginsCommand(["enable", "gitlab"], options)).toBe(1);
    expect(lines.join("\n")).toContain("Not turned on");
    expect(await pluginsCommand(["enable", "github"], options)).toBe(0);
    expect(saved.at(-1)).toEqual({ AGENT_PLUGINS: "github" });
    expect(lines.join("\n")).toContain("Under the service's terms.");
    expect(await pluginsCommand(["enable", "bitbucket"], options)).toBe(2);
    await pluginsCommand(["list"], options);
    expect(lines.join("\n")).toMatch(/\[on\] +GitHub/);
    expect(await pluginsCommand(["disable", "github"], options)).toBe(0);
    expect(saved.at(-1)).toEqual({ AGENT_PLUGINS: "" });
  });

  it("give the session the tools of those connected, and say which are not", async () => {
    const found = await connectPlugins({ AGENT_PLUGINS: "github, gitlab, unknown" }, ".", (id) =>
      fake(id, id === "github"),
    );
    expect(found.tools.map((t) => t.name)).toEqual(["github_x"]);
    expect(found.states.map((s) => [s.id, s.status.ready, s.tools])).toEqual([
      ["github", true, 1],
      ["gitlab", false, 0],
    ]);
    expect(found.notes).toEqual(["Plugin GitLab is on but not connected: Not connected."]);
  });
});
