import type { Tool } from "../agent/tools.js";
import { COMMON_NEVER, DATA_NOTE, limitOf, rawApiTool, short, str } from "./common.js";
import { projectRemotes } from "./repo.js";
import { cliTransport, ok, runProgram, tokenTransport } from "./transport.js";
import type { ApiTransport, Plugin, PluginContext, PluginStatus } from "./types.js";

type Json = Record<string, unknown>;

export interface GitHubOptions {
  readonly env?: Record<string, string | undefined>;
  /** Runs a program; for tests. */
  readonly run?: typeof runProgram;
  readonly fetch?: typeof fetch;
  /** The transport, ready; for tests. */
  readonly transport?: ApiTransport;
}

const HOST = "github.com";

/**
 * GitHub, through its REST API: with the official `gh` CLI's own sign-in
 * (`gh auth login`), or a personal access token the user made
 * (GITHUB_TOKEN or GH_TOKEN). Both are what GitHub documents for API use.
 */
export function githubPlugin(options: GitHubOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const run = options.run ?? runProgram;
  const token = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  const apiBase = env.GITHUB_API_URL?.trim() || "https://api.github.com";
  let found: Promise<{ status: PluginStatus; transport?: ApiTransport }> | undefined;

  const find = () =>
    (found ??= (async () => {
      if (options.transport) {
        return {
          status: { ready: true, via: "cli", host: HOST, detail: "test" },
          transport: options.transport,
        };
      }
      // The official CLI first: its sign-in stays with it.
      const signed = await run("gh", ["auth", "status", "--hostname", HOST]).catch(() => undefined);
      if (signed?.code === 0) {
        const transport = cliTransport("gh", { run });
        const user = await transport.request("GET", "user").catch(() => undefined);
        const login = str((user?.data as Json | undefined)?.login);
        return {
          status: {
            ready: true,
            via: "cli",
            host: HOST,
            ...(login ? { account: login } : {}),
            detail: `Through the gh CLI's own sign-in${login ? ` as ${login}` : ""}.`,
          },
          transport,
        };
      }
      if (token !== "") {
        const transport = tokenTransport(
          apiBase,
          {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          options.fetch,
        );
        const user = await transport.request("GET", "user").catch((error: unknown) => ({
          status: 0,
          data: undefined,
          text: error instanceof Error ? error.message : String(error),
        }));
        if (user.status === 200) {
          const login = str((user.data as Json).login);
          return {
            status: {
              ready: true,
              via: "token",
              host: HOST,
              account: login,
              detail: `With your token, as ${login}.`,
            },
            transport,
          };
        }
        return {
          status: {
            ready: false,
            via: "token",
            host: HOST,
            detail: `GitHub refused the token (${String(user.status)}): make a new one.`,
          },
        };
      }
      return {
        status: {
          ready: false,
          host: HOST,
          detail: signed
            ? "gh is installed but not signed in: run gh auth login."
            : "Not connected: install gh and run gh auth login, or set GITHUB_TOKEN.",
        },
      };
    })());

  return {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, checks and search on GitHub, as you.",
    terms: [
      "Uses GitHub's public REST API under GitHub's Terms of Service, within your account's own permissions and rate limits.",
      "Sign-in: the official gh CLI's own (the agent never reads its token), or a personal access token you made (GITHUB_TOKEN or GH_TOKEN). Give a token only the scopes you want the agent to have.",
    ],
    connect:
      "Install the GitHub CLI and run gh auth login, or set GITHUB_TOKEN to a token you made.",
    status: async () => (await find()).status,
    tools: async (context) => {
      const { transport } = await find();
      return transport ? githubTools(transport, context) : [];
    },
  };
}

/** The repository a call is about: the one given, else the project's GitHub remote. */
async function repoOf(input: Json, context: PluginContext): Promise<string> {
  const given = str(input.repo).trim();
  if (given !== "") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(given)) throw new Error(`repo is owner/name: ${given}`);
    return given;
  }
  const remote = (await projectRemotes(context.root)).find((r) => r.host === HOST);
  if (!remote) throw new Error("the project has no GitHub remote: say the repo, as owner/name");
  return remote.path;
}

const REPO = { type: "string", description: "owner/name. Default: the project's GitHub remote." };

function issueLine(issue: Json): string {
  const labels =
    (issue.labels as Json[] | undefined)?.map((l) => str(l.name)).filter(Boolean) ?? [];
  return `#${String(issue.number)} [${str(issue.state)}] ${str(issue.title)} — ${str((issue.user as Json | undefined)?.login)}${labels.length ? ` (${labels.join(", ")})` : ""}`;
}

export function githubTools(transport: ApiTransport, context: PluginContext): Tool[] {
  const get = async (path: string, what: string, signal: AbortSignal) =>
    ok(await transport.request("GET", path, undefined, signal), what);
  const send = async (
    method: string,
    path: string,
    body: unknown,
    what: string,
    signal: AbortSignal,
  ) => ok(await transport.request(method, path, body, signal), what);

  return [
    {
      name: "github_repo",
      description:
        "A GitHub repository: description, default branch, visibility, stars, open issues, latest release.",
      inputSchema: { type: "object", properties: { repo: REPO }, additionalProperties: false },
      writes: false,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const data = (await get(`repos/${repo}`, repo, signal)) as Json;
        const release = await transport.request(
          "GET",
          `repos/${repo}/releases/latest`,
          undefined,
          signal,
        );
        return [
          `${str(data.full_name)} ${DATA_NOTE}: ${str(data.description)}`,
          `Default branch ${str(data.default_branch)} · ${data.private ? "private" : "public"} · ${String(data.stargazers_count)} stars · ${String(data.open_issues_count)} open issues and PRs`,
          `Latest release: ${release.status === 200 ? `${str((release.data as Json).tag_name)} (${str((release.data as Json).published_at).slice(0, 10)})` : "none"}`,
          str(data.html_url),
        ].join("\n");
      },
    },
    {
      name: "github_list_issues",
      description: "Issues of a GitHub repository (not pull requests), newest first.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO,
          state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
          labels: { type: "string", description: "Comma-separated labels." },
          limit: { type: "integer", description: "Default 20, at most 100." },
        },
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const query = new URLSearchParams({
          state: str(input.state, "open"),
          per_page: String(limitOf(input.limit)),
        });
        if (str(input.labels)) query.set("labels", str(input.labels));
        const issues = (
          (await get(`repos/${repo}/issues?${query.toString()}`, repo, signal)) as Json[]
        ).filter((i) => i.pull_request === undefined);
        return issues.length === 0
          ? "No issues."
          : `Issues of ${repo} ${DATA_NOTE}:\n${issues.map(issueLine).join("\n")}`;
      },
    },
    {
      name: "github_get_issue",
      description: "One GitHub issue or pull request's conversation: its text and its comments.",
      inputSchema: {
        type: "object",
        properties: { repo: REPO, number: { type: "integer" } },
        required: ["number"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const n = String(input.number);
        const issue = (await get(`repos/${repo}/issues/${n}`, `#${n}`, signal)) as Json;
        const comments = (await get(
          `repos/${repo}/issues/${n}/comments?per_page=50`,
          `#${n}`,
          signal,
        )) as Json[];
        return [
          `${issueLine(issue)} ${DATA_NOTE}`,
          str(issue.html_url),
          short(issue.body),
          ...comments.map(
            (c) =>
              `\n— ${str((c.user as Json | undefined)?.login)}, ${str(c.created_at).slice(0, 10)}:\n${short(c.body, 1500)}`,
          ),
        ].join("\n");
      },
    },
    {
      name: "github_list_prs",
      description: "Pull requests of a GitHub repository, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO,
          state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
          limit: { type: "integer", description: "Default 20, at most 100." },
        },
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const prs = (await get(
          `repos/${repo}/pulls?state=${str(input.state, "open")}&per_page=${String(limitOf(input.limit))}`,
          repo,
          signal,
        )) as Json[];
        if (prs.length === 0) return "No pull requests.";
        return `Pull requests of ${repo} ${DATA_NOTE}:\n${prs
          .map(
            (p) =>
              `#${String(p.number)} [${p.draft ? "draft" : str(p.state)}] ${str(p.title)} — ${str((p.user as Json | undefined)?.login)} (${str((p.head as Json | undefined)?.ref)} → ${str((p.base as Json | undefined)?.ref)})`,
          )
          .join("\n")}`;
      },
    },
    {
      name: "github_get_pr",
      description:
        "One GitHub pull request: its state, branches, description, files changed and its checks.",
      inputSchema: {
        type: "object",
        properties: { repo: REPO, number: { type: "integer" } },
        required: ["number"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const n = String(input.number);
        const pr = (await get(`repos/${repo}/pulls/${n}`, `PR #${n}`, signal)) as Json;
        const files = (await get(
          `repos/${repo}/pulls/${n}/files?per_page=100`,
          `PR #${n}`,
          signal,
        )) as Json[];
        const sha = str((pr.head as Json | undefined)?.sha);
        const checks = await transport.request(
          "GET",
          `repos/${repo}/commits/${sha}/check-runs?per_page=50`,
          undefined,
          signal,
        );
        const runs = checks.status === 200 ? ((checks.data as Json).check_runs as Json[]) : [];
        return [
          `PR #${n} [${pr.merged ? "merged" : pr.draft ? "draft" : str(pr.state)}] ${str(pr.title)} ${DATA_NOTE}`,
          `${str((pr.head as Json | undefined)?.ref)} → ${str((pr.base as Json | undefined)?.ref)} · by ${str((pr.user as Json | undefined)?.login)} · mergeable: ${typeof pr.mergeable === "boolean" ? String(pr.mergeable) : "unknown"}`,
          str(pr.html_url),
          short(pr.body, 3000),
          `Files (${String(files.length)}):`,
          ...files.map(
            (f) =>
              `  ${str(f.status)} ${str(f.filename)} +${String(f.additions)} -${String(f.deletions)}`,
          ),
          `Checks (${String(runs.length)}):`,
          ...runs.map(
            (r) =>
              `  ${str(r.name)}: ${str(r.status)}${r.conclusion ? ` / ${str(r.conclusion)}` : ""}`,
          ),
        ].join("\n");
      },
    },
    {
      name: "github_search",
      description:
        "Searches GitHub: issues and pull requests, code, or repositories, with GitHub's search syntax (such as repo:owner/name is:open label:bug).",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["issues", "code", "repositories"] },
          query: { type: "string" },
          limit: { type: "integer", description: "Default 20, at most 100." },
        },
        required: ["kind", "query"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const kind = str(input.kind);
        const data = (await get(
          `search/${kind}?q=${encodeURIComponent(str(input.query))}&per_page=${String(limitOf(input.limit))}`,
          "search",
          signal,
        )) as Json;
        const items = (data.items as Json[] | undefined) ?? [];
        const line = (i: Json) =>
          kind === "code"
            ? `${str((i.repository as Json | undefined)?.full_name)}: ${str(i.path)}`
            : kind === "repositories"
              ? `${str(i.full_name)} — ${str(i.description)} (${String(i.stargazers_count)} stars)`
              : `${str(i.repository_url).split("/repos/")[1] ?? ""}${issueLine(i)}`;
        return `${String(data.total_count)} found ${DATA_NOTE}:\n${items.map(line).join("\n")}`;
      },
    },
    {
      name: "github_create_issue",
      description: "Opens an issue on a GitHub repository. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO,
          title: { type: "string" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({
        permission: "ask",
        reason: "it opens an issue on GitHub, public if the repository is",
      }),
      describe: (input) =>
        `open an issue on ${str(input.repo, "the project's repository")}: ${str(input.title)}\n${short(input.body, 600)}`,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const issue = (await send(
          "POST",
          `repos/${repo}/issues`,
          {
            title: input.title,
            ...(input.body ? { body: input.body } : {}),
            ...(input.labels ? { labels: input.labels } : {}),
          },
          "the issue",
          signal,
        )) as Json;
        return `Opened #${String(issue.number)}: ${str(issue.html_url)}`;
      },
    },
    {
      name: "github_comment",
      description: "Comments on a GitHub issue or pull request. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: { repo: REPO, number: { type: "integer" }, body: { type: "string" } },
        required: ["number", "body"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({ permission: "ask", reason: "it posts a comment on GitHub as you" }),
      describe: (input) => `comment on #${String(input.number)}:\n${short(input.body, 800)}`,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        const comment = (await send(
          "POST",
          `repos/${repo}/issues/${String(input.number)}/comments`,
          { body: input.body },
          "the comment",
          signal,
        )) as Json;
        return `Commented: ${str(comment.html_url)}`;
      },
    },
    {
      name: "github_create_pr",
      description:
        "Opens a pull request on GitHub from a branch already pushed. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO,
          title: { type: "string" },
          head: { type: "string", description: "The branch with the changes (pushed)." },
          base: {
            type: "string",
            description: "The branch to merge into. Default: the default branch.",
          },
          body: { type: "string" },
          draft: { type: "boolean" },
        },
        required: ["title", "head"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({ permission: "ask", reason: "it opens a pull request on GitHub as you" }),
      describe: (input) =>
        `open a pull request ${str(input.head)} → ${str(input.base, "the default branch")}: ${str(input.title)}\n${short(input.body, 600)}`,
      run: async (input, { signal }) => {
        const repo = await repoOf(input, context);
        let base = str(input.base);
        if (base === "")
          base = str(((await get(`repos/${repo}`, repo, signal)) as Json).default_branch);
        const pr = (await send(
          "POST",
          `repos/${repo}/pulls`,
          {
            title: input.title,
            head: input.head,
            base,
            ...(input.body ? { body: input.body } : {}),
            draft: input.draft === true,
          },
          "the pull request",
          signal,
        )) as Json;
        return `Opened PR #${String(pr.number)}: ${str(pr.html_url)}`;
      },
    },
    rawApiTool({
      name: "github_api",
      service: "GitHub",
      docs: "https://docs.github.com/rest",
      transport,
      never: [
        ...COMMON_NEVER,
        {
          method: /^DELETE$/,
          path: /^\/repos\/[^/]+\/[^/]+\/?$/i,
          reason: "it would delete the whole repository",
        },
        {
          method: /^DELETE$/,
          path: /^\/orgs\/[^/]+\/?$/i,
          reason: "it would delete an organization",
        },
        {
          path: /\/hooks(\/|$)/i,
          method: /^(POST|PUT|PATCH|DELETE)$/,
          reason: "webhooks send the repository's events elsewhere: set them up yourself",
        },
      ],
    }),
  ];
}
