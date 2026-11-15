import type { Tool } from "../agent/tools.js";
import { COMMON_NEVER, DATA_NOTE, limitOf, rawApiTool, short, str } from "./common.js";
import { projectRemotes } from "./repo.js";
import { cliTransport, ok, runProgram, tokenTransport } from "./transport.js";
import type { ApiTransport, Plugin, PluginContext, PluginStatus } from "./types.js";

type Json = Record<string, unknown>;

export interface GitLabOptions {
  readonly env?: Record<string, string | undefined>;
  readonly run?: typeof runProgram;
  readonly fetch?: typeof fetch;
  readonly transport?: ApiTransport;
}

/**
 * GitLab (gitlab.com, or a GitLab of your own with GITLAB_HOST), through
 * its REST API v4: with the official `glab` CLI's own sign-in
 * (`glab auth login`), or a personal access token the user made
 * (GITLAB_TOKEN). Both are what GitLab documents for API use.
 */
export function gitlabPlugin(options: GitLabOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const run = options.run ?? runProgram;
  const host = (env.GITLAB_HOST?.trim() || "gitlab.com")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const token = (env.GITLAB_TOKEN ?? "").trim();
  let found: Promise<{ status: PluginStatus; transport?: ApiTransport }> | undefined;

  const find = () =>
    (found ??= (async () => {
      if (options.transport) {
        return {
          status: { ready: true, via: "cli", host, detail: "test" },
          transport: options.transport,
        };
      }
      const signed = await run("glab", ["auth", "status", "--hostname", host]).catch(
        () => undefined,
      );
      if (signed?.code === 0) {
        const transport = cliTransport("glab", { run, hostname: host });
        const user = await transport.request("GET", "user").catch(() => undefined);
        const name = str((user?.data as Json | undefined)?.username);
        return {
          status: {
            ready: true,
            via: "cli",
            host,
            ...(name ? { account: name } : {}),
            detail: `Through the glab CLI's own sign-in${name ? ` as ${name}` : ""}.`,
          },
          transport,
        };
      }
      if (token !== "") {
        const transport = tokenTransport(
          `https://${host}/api/v4`,
          { "private-token": token },
          options.fetch,
        );
        const user = await transport.request("GET", "user").catch((error: unknown) => ({
          status: 0,
          data: undefined,
          text: error instanceof Error ? error.message : String(error),
        }));
        if (user.status === 200) {
          const name = str((user.data as Json).username);
          return {
            status: {
              ready: true,
              via: "token",
              host,
              account: name,
              detail: `With your token, as ${name}.`,
            },
            transport,
          };
        }
        return {
          status: {
            ready: false,
            via: "token",
            host,
            detail: `${host} refused the token (${String(user.status)}): make a new one.`,
          },
        };
      }
      return {
        status: {
          ready: false,
          host,
          detail: signed
            ? `glab is installed but not signed in to ${host}: run glab auth login.`
            : "Not connected: install glab and run glab auth login, or set GITLAB_TOKEN.",
        },
      };
    })());

  return {
    id: "gitlab",
    name: "GitLab",
    description: "Projects, issues, merge requests, pipelines and search on GitLab, as you.",
    terms: [
      `Uses GitLab's public REST API (v4) on ${host}, under that GitLab's terms, within your account's own permissions and rate limits.`,
      "Sign-in: the official glab CLI's own (the agent never reads its token), or a personal access token you made (GITLAB_TOKEN). Give a token only the scopes you want the agent to have (read_api to only read).",
    ],
    connect:
      "Install the GitLab CLI and run glab auth login, or set GITLAB_TOKEN (and GITLAB_HOST for your own GitLab).",
    status: async () => (await find()).status,
    tools: async (context) => {
      const { transport } = await find();
      return transport ? gitlabTools(transport, context, host) : [];
    },
  };
}

const PROJECT = {
  type: "string",
  description: "group/…/name. Default: the project's GitLab remote.",
};

export function gitlabTools(
  transport: ApiTransport,
  context: PluginContext,
  host = "gitlab.com",
): Tool[] {
  /** The project a call is about, as the API's id (its path, encoded). */
  const projectOf = async (input: Json): Promise<string> => {
    const given = str(input.project).trim();
    if (given !== "") {
      if (!/^[\w.-]+(\/[\w.-]+)+$/.test(given)) throw new Error(`project is group/name: ${given}`);
      return encodeURIComponent(given);
    }
    const remote = (await projectRemotes(context.root)).find((r) => r.host === host);
    if (!remote)
      throw new Error(`the project has no ${host} remote: say the project, as group/name`);
    return encodeURIComponent(remote.path);
  };
  const get = async (path: string, what: string, signal: AbortSignal) =>
    ok(await transport.request("GET", path, undefined, signal), what);
  const send = async (
    method: string,
    path: string,
    body: unknown,
    what: string,
    signal: AbortSignal,
  ) => ok(await transport.request(method, path, body, signal), what);
  const line = (item: Json, mark: string) =>
    `${mark}${String(item.iid)} [${str(item.state)}] ${str(item.title)} — ${str((item.author as Json | undefined)?.username)}${(item.labels as string[] | undefined)?.length ? ` (${(item.labels as string[]).join(", ")})` : ""}`;
  const listing =
    (kind: "issues" | "merge_requests", mark: string) =>
    async (input: Json, { signal }: { signal: AbortSignal }) => {
      const id = await projectOf(input);
      const state = str(input.state, "opened");
      const query = new URLSearchParams({
        per_page: String(limitOf(input.limit)),
        order_by: "created_at",
      });
      if (state !== "all") query.set("state", state);
      if (str(input.labels)) query.set("labels", str(input.labels));
      const items = (await get(
        `projects/${id}/${kind}?${query.toString()}`,
        kind,
        signal,
      )) as Json[];
      return items.length === 0
        ? `No ${kind.replace("_", " ")}.`
        : `${DATA_NOTE}\n${items.map((i) => line(i, mark)).join("\n")}`;
    };
  const listSchema = (states: string[]) => ({
    type: "object",
    properties: {
      project: PROJECT,
      state: {
        type: "string",
        enum: [...states, "all"],
        description: `Default ${states[0] ?? "opened"}.`,
      },
      labels: { type: "string", description: "Comma-separated labels." },
      limit: { type: "integer", description: "Default 20, at most 100." },
    },
    additionalProperties: false,
  });
  const notes = async (id: string, kind: string, iid: string, signal: AbortSignal) =>
    (
      (await get(
        `projects/${id}/${kind}/${iid}/notes?per_page=50&sort=asc`,
        "the comments",
        signal,
      )) as Json[]
    )
      .filter((n) => n.system !== true)
      .map(
        (n) =>
          `\n— ${str((n.author as Json | undefined)?.username)}, ${str(n.created_at).slice(0, 10)}:\n${short(n.body, 1500)}`,
      );

  return [
    {
      name: "gitlab_project",
      description:
        "A GitLab project: description, default branch, visibility, stars, open issues, latest release.",
      inputSchema: {
        type: "object",
        properties: { project: PROJECT },
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const p = (await get(`projects/${id}`, "the project", signal)) as Json;
        const releases = await transport.request(
          "GET",
          `projects/${id}/releases?per_page=1`,
          undefined,
          signal,
        );
        const latest = releases.status === 200 ? (releases.data as Json[])[0] : undefined;
        return [
          `${str(p.path_with_namespace)} ${DATA_NOTE}: ${str(p.description)}`,
          `Default branch ${str(p.default_branch)} · ${str(p.visibility)} · ${String(p.star_count)} stars · ${typeof p.open_issues_count === "number" ? String(p.open_issues_count) : "?"} open issues`,
          `Latest release: ${latest ? `${str(latest.tag_name)} (${str(latest.released_at).slice(0, 10)})` : "none"}`,
          str(p.web_url),
        ].join("\n");
      },
    },
    {
      name: "gitlab_list_issues",
      description: "Issues of a GitLab project, newest first.",
      inputSchema: listSchema(["opened", "closed"]),
      writes: false,
      run: listing("issues", "#"),
    },
    {
      name: "gitlab_get_issue",
      description: "One GitLab issue: its text and its comments.",
      inputSchema: {
        type: "object",
        properties: { project: PROJECT, iid: { type: "integer" } },
        required: ["iid"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const iid = String(input.iid);
        const issue = (await get(`projects/${id}/issues/${iid}`, `#${iid}`, signal)) as Json;
        return [
          `${line(issue, "#")} ${DATA_NOTE}`,
          str(issue.web_url),
          short(issue.description),
          ...(await notes(id, "issues", iid, signal)),
        ].join("\n");
      },
    },
    {
      name: "gitlab_list_mrs",
      description: "Merge requests of a GitLab project, newest first.",
      inputSchema: listSchema(["opened", "closed", "merged"]),
      writes: false,
      run: listing("merge_requests", "!"),
    },
    {
      name: "gitlab_get_mr",
      description:
        "One GitLab merge request: its state, branches, description, files changed, its pipeline and comments.",
      inputSchema: {
        type: "object",
        properties: { project: PROJECT, iid: { type: "integer" } },
        required: ["iid"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const iid = String(input.iid);
        const mr = (await get(`projects/${id}/merge_requests/${iid}`, `!${iid}`, signal)) as Json;
        const diffs = await transport.request(
          "GET",
          `projects/${id}/merge_requests/${iid}/diffs?per_page=100`,
          undefined,
          signal,
        );
        const files = diffs.status === 200 ? (diffs.data as Json[]) : [];
        const pipeline = mr.head_pipeline as Json | undefined;
        return [
          `${line(mr, "!")} ${DATA_NOTE}`,
          `${str(mr.source_branch)} → ${str(mr.target_branch)} · merge status: ${str(mr.detailed_merge_status, str(mr.merge_status))}`,
          `Pipeline: ${pipeline ? `${str(pipeline.status)} (${str(pipeline.web_url)})` : "none"}`,
          str(mr.web_url),
          short(mr.description, 3000),
          `Files (${String(files.length)}):`,
          ...files.map(
            (f) =>
              `  ${f.new_file ? "added" : f.deleted_file ? "deleted" : f.renamed_file ? "renamed" : "modified"} ${str(f.new_path)}`,
          ),
          ...(await notes(id, "merge_requests", iid, signal)),
        ].join("\n");
      },
    },
    {
      name: "gitlab_pipelines",
      description:
        "The latest CI pipelines of a GitLab project (optionally of one branch), with the jobs of the newest.",
      inputSchema: {
        type: "object",
        properties: {
          project: PROJECT,
          ref: { type: "string", description: "A branch or tag." },
          limit: { type: "integer", description: "Default 10." },
        },
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const query = new URLSearchParams({ per_page: String(limitOf(input.limit, 10)) });
        if (str(input.ref)) query.set("ref", str(input.ref));
        const pipelines = (await get(
          `projects/${id}/pipelines?${query.toString()}`,
          "the pipelines",
          signal,
        )) as Json[];
        if (pipelines.length === 0) return "No pipelines.";
        const newest = pipelines[0] as Json;
        const jobs = (await get(
          `projects/${id}/pipelines/${String(newest.id)}/jobs?per_page=100`,
          "the jobs",
          signal,
        )) as Json[];
        return [
          `Pipelines ${DATA_NOTE}:`,
          ...pipelines.map(
            (p) =>
              `  ${String(p.id)} ${str(p.status)} on ${str(p.ref)} (${str(p.sha).slice(0, 8)}) ${str(p.created_at).slice(0, 16)}`,
          ),
          `Jobs of ${String(newest.id)}:`,
          ...jobs.map((j) => `  ${str(j.stage)} / ${str(j.name)}: ${str(j.status)}`),
        ].join("\n");
      },
    },
    {
      name: "gitlab_search",
      description:
        "Searches inside a GitLab project: issues, merge requests, code (blobs) or commits.",
      inputSchema: {
        type: "object",
        properties: {
          project: PROJECT,
          scope: { type: "string", enum: ["issues", "merge_requests", "blobs", "commits"] },
          query: { type: "string" },
          limit: { type: "integer", description: "Default 20." },
        },
        required: ["scope", "query"],
        additionalProperties: false,
      },
      writes: false,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const scope = str(input.scope);
        const items = (await get(
          `projects/${id}/search?scope=${scope}&search=${encodeURIComponent(str(input.query))}&per_page=${String(limitOf(input.limit))}`,
          "search",
          signal,
        )) as Json[];
        const show = (i: Json) =>
          scope === "blobs"
            ? `${str(i.path)}:${String(i.startline)}: ${short(i.data, 200).replace(/\n/g, " ")}`
            : scope === "commits"
              ? `${str(i.short_id)} ${str(i.title)} — ${str(i.author_name)}`
              : line(i, scope === "issues" ? "#" : "!");
        return items.length === 0
          ? "Nothing found."
          : `${DATA_NOTE}\n${items.map(show).join("\n")}`;
      },
    },
    {
      name: "gitlab_create_issue",
      description: "Opens an issue on a GitLab project. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: {
          project: PROJECT,
          title: { type: "string" },
          description: { type: "string" },
          labels: { type: "string", description: "Comma-separated." },
        },
        required: ["title"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({ permission: "ask", reason: "it opens an issue on GitLab as you" }),
      describe: (input) =>
        `open an issue on ${str(input.project, "the project")}: ${str(input.title)}\n${short(input.description, 600)}`,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const issue = (await send(
          "POST",
          `projects/${id}/issues`,
          {
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            ...(input.labels ? { labels: input.labels } : {}),
          },
          "the issue",
          signal,
        )) as Json;
        return `Opened #${String(issue.iid)}: ${str(issue.web_url)}`;
      },
    },
    {
      name: "gitlab_comment",
      description: "Comments on a GitLab issue or merge request. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: {
          project: PROJECT,
          kind: { type: "string", enum: ["issue", "merge_request"] },
          iid: { type: "integer" },
          body: { type: "string" },
        },
        required: ["kind", "iid", "body"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({ permission: "ask", reason: "it posts a comment on GitLab as you" }),
      describe: (input) =>
        `comment on ${input.kind === "issue" ? "#" : "!"}${String(input.iid)}:\n${short(input.body, 800)}`,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        const kind = input.kind === "issue" ? "issues" : "merge_requests";
        await send(
          "POST",
          `projects/${id}/${kind}/${String(input.iid)}/notes`,
          { body: input.body },
          "the comment",
          signal,
        );
        return `Commented on ${input.kind === "issue" ? "#" : "!"}${String(input.iid)}.`;
      },
    },
    {
      name: "gitlab_create_mr",
      description:
        "Opens a merge request on GitLab from a branch already pushed. The user is asked first.",
      inputSchema: {
        type: "object",
        properties: {
          project: PROJECT,
          title: { type: "string" },
          source_branch: { type: "string" },
          target_branch: { type: "string", description: "Default: the default branch." },
          description: { type: "string" },
          draft: { type: "boolean" },
        },
        required: ["title", "source_branch"],
        additionalProperties: false,
      },
      writes: true,
      permission: () => ({
        permission: "ask",
        reason: "it opens a merge request on GitLab as you",
      }),
      describe: (input) =>
        `open a merge request ${str(input.source_branch)} → ${str(input.target_branch, "the default branch")}: ${str(input.title)}\n${short(input.description, 600)}`,
      run: async (input, { signal }) => {
        const id = await projectOf(input);
        let target = str(input.target_branch);
        if (target === "")
          target = str(
            ((await get(`projects/${id}`, "the project", signal)) as Json).default_branch,
          );
        const mr = (await send(
          "POST",
          `projects/${id}/merge_requests`,
          {
            title: input.draft === true ? `Draft: ${str(input.title)}` : input.title,
            source_branch: input.source_branch,
            target_branch: target,
            ...(input.description ? { description: input.description } : {}),
          },
          "the merge request",
          signal,
        )) as Json;
        return `Opened !${String(mr.iid)}: ${str(mr.web_url)}`;
      },
    },
    rawApiTool({
      name: "gitlab_api",
      service: "GitLab",
      docs: "https://docs.gitlab.com/api/rest/",
      transport,
      never: [
        ...COMMON_NEVER,
        {
          method: /^DELETE$/,
          path: /^\/projects\/[^/]+\/?$/i,
          reason: "it would delete the whole project",
        },
        { method: /^DELETE$/, path: /^\/groups\/[^/]+\/?$/i, reason: "it would delete a group" },
        {
          path: /\/hooks(\/|$)/i,
          method: /^(POST|PUT|PATCH|DELETE)$/,
          reason: "webhooks send the project's events elsewhere: set them up yourself",
        },
      ],
    }),
  ];
}
