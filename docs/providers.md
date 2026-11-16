# Providers: sign-in, models and execution, kept apart

Decided with the user on 2026-11-15; built the same day, in their order:
Claude first, then Codex, then Gemini.

## The decision

- **The architecture stays extensible, with three separate parts per
  provider** (`src/providers/types.ts`):
  - **authentication** (`ProviderAuth`): who it answers as, its billing and
    usage;
  - **model selection** (`ModelCatalog`): models, tiers, efforts, names;
  - **execution** (`ProviderRuntime`): making a model, what the adapter can
    do.

  `ComposedProvider` (`compose.ts`) shows the rest of the agent one
  `Provider` built from them. One part can be replaced (the authentication
  is wrapped in a cache, for example) without touching the others. Tests
  show that making a model asks nothing of the sign-in.

- **Claude:** the adapter on the official `claude` CLI, under Anthropic's
  terms.
- **Codex:** the adapter on the official `codex` CLI, with its native
  ChatGPT sign-in. Tokens are never extracted or reused.
- **Gemini:** Google AI Studio's API is the default integration. `agy -p` is
  never wrapped with a consumer Google sign-in.
- **The agent's own sign-in for third parties:** only flows that are
  officially documented and authorized are looked at. Unconfirmed OAuth
  flows are never built.
- **Costs:** a subscription's quota, an API's free quota and billing by
  consumption are kept apart. No billable service, and no paid fallback,
  without the user's express authorization.
- **Credentials** stay under each provider's control, or in the system's
  secure store. Never in Grafeno.

## What was built

| Part            | Claude Code                                             | Codex                                        | Gemini                                                                         |
| --------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Authentication  | `claude` holds it; `auth status`, `/usage`              | `codex` holds it; `login status`, app-server | The user's AI Studio key: environment, else the secure store                   |
| Billing         | claude.ai sign-in: subscription; API key/cloud: metered | ChatGPT: subscription; API key: metered      | Declared `free`: free quota; `paid` or undeclared: metered                     |
| Usage           | `/usage` (local, free)                                  | `account/rateLimits/read` (free)             | None: Google's API does not report a key's quota                               |
| Model selection | Family aliases, exact names from `/model`               | `codex debug models`                         | `GET /models` (free); tiers on `gemini-{pro,flash,flash-lite}-latest`          |
| Execution       | `claude -p`, the agent's tools over MCP                 | `codex exec`, the agent's tools over MCP     | `generateContent`; the agent's tools as function declarations, run by its host |

**Billing gate** (`billing.ts`):

- A metered provider is used only when `AGENT_ALLOW_BILLING` names it.
- The registry leaves it out of the ready providers, so no fallback lands
  on it.
- A chat session, or a run with one provider, refuses it before anything
  is planned.

**Gemini's key** (`secrets.ts`, `grafeno-agent login gemini`):

- The key is checked by listing models, which spends nothing.
- It is kept in the system's secure store:
  - Windows: DPAPI, for this user only, through PowerShell, with the key
    in an environment variable, never an argument;
  - Linux: the Secret Service (`secret-tool`, from standard input);
  - macOS: the Keychain. The person adds the key with `security`, since
    storing it from the agent would put it in a command's arguments.
- The tier the user declares goes to the settings file. The key never
  does.
- Requests carry the key in a header, never the URL.
- Errors never include it.
- Commands the agent runs never see `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

**A short cache** (`cache.ts`):

- A provider's status and usage are reused for 60 seconds. The cache is
  shared across the agent's processes through `provider-state.json` in the
  data folder, which holds no credential.
- Calls made at once share one question, and a failed answer is not kept.
- `/usage` shows the reading's age; `/usage refresh` asks again.
- Measured on Claude Code: 6.5 s cold, 1 ms cached.

## Research (2026-11-15)

- **Google Antigravity:**
  - Its [additional terms](https://antigravity.google/terms), item 6, call
    using third-party software to access the service a breach, which may
    lead to suspension.
  - Its [FAQ](https://antigravity.google/docs/faq/) says a third-party tool
    with the Antigravity sign-in violates the terms. It says wrapping `agy`
    in third-party apps "is not supported under consumer plans". It
    recommends a Google AI Studio or Gemini Enterprise key.
  - [Users report suspensions](https://discuss.ai.google.dev/t/got-banned-from-antigravity-for-using-opencode-submitted-appeal-but-still-locked-out/131169),
    including of paid plans.
  - Hence AI Studio, and no `agy` with a consumer sign-in.
- **Anthropic:** since February 2026, Free, Pro and Max OAuth tokens may
  not be used in any other product, the Agent SDK included
  ([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)).
  Claude stays on its own CLI.
- **OpenAI:** "Sign in with ChatGPT" is
  [officially documented](https://developers.openai.com/siwc/token-sharing-open-source)
  for open-source projects and personal apps run locally:
  - **Registration:** dynamic (`client_id=dynamic_agent_client`, then an
    `oaiapp_…` client id of the app's own).
  - **Sign-in:** PKCE, a `127.0.0.1` loopback, and the scopes
    `offline_access resource.invoke chatgpt.tokens.use.direct`.
  - **Use:** `POST /v1/responses` with `store: false`.
  - **Tokens:** kept in protected local storage.
  - **Status:** it is a preview. Some of its pages also speak of a waitlist
    for commercial partners.

  It is the one official way for the agent to sign in to ChatGPT without
  the Codex CLI. Not built: per the decision, it is looked at only, and
  building it is the user's call.

## Auto's providers, and OpenRouter (2026-11-15)

Asked by the user: choose which providers Auto includes, so that it uses
the subscriptions (the official CLIs on this computer) and never an API
that bills per token; add OpenRouter with an API key; check every key when
it is added, not only when it is first used.

- **`AGENT_AUTO_PROVIDERS`** lists what Auto includes. Empty means none:
  the user chooses, and Auto warns until then. Asked again the same day,
  Auto never picks providers on its own. Providers reached with an API key
  (`API_KEY_PROVIDERS`: `gemini`, `openrouter`) carry a warning that they
  may bill per token.
  - In `/connect`, **space** toggles one.
  - Login asks whether to include the provider, with no as the default.
  - Auto's pool, its triage and its runs use only these providers, and
    never a metered one unless allowed.
  - A named provider's fallbacks are limited to Auto's members too.
    Before, they were every known provider.
- **OpenRouter** (`src/providers/openrouter.ts`, `src/model/openai-chat.ts`):
  - **Authentication:** the user's key, from `OPENROUTER_API_KEY` or the
    secure store, checked with `GET /api/v1/key` (it spends nothing; a 401
    is a refused key).
  - **Billing:** `OPENROUTER_MODELS=free` (the default) is free-api;
    `all` is metered.
  - **Models:** `GET /api/v1/models?supported_parameters=tools`, keeping
    in free mode only `:free` models priced `"0"`. Every tier goes to
    `openrouter/free`, OpenRouter's router that picks a free model and
    falls back only to free ones. Its listing, checked on 2026-11-15, is
    priced `"0"` and takes `tools`.
  - **Execution:** chat completions in OpenAI's format; the agent's tools
    as functions, run by its own host. In free mode a model that is not
    free is refused before any request, and no `models` fallback list is
    ever sent.
  - **Errors:** a 401 is a key problem; a 402 means no credits; a 429 is a
    rate limit, retried after `Retry-After`; 5xx and 408 are unavailable;
    an error in a 200 is a failure.
  - **Usage:** today's free requests and the key's credit limit, both from
    `/key`.
  - Sources: OpenRouter's [limits](https://openrouter.ai/docs/api-reference/limits),
    [tool calling](https://openrouter.ai/docs/features/tool-calling),
    [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free.md)
    and [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md).
- **Keys checked when added:** `login gemini` and `login openrouter` keep
  a key only after the provider accepted it, and say what it reported. A
  key from the environment is checked whenever the status is read (once a
  minute at most, with the cache).

## claude-api, the switches, and Codex audited (2026-11-16)

Asked by the user:

- a `claude-api` provider on the official Claude Agent SDK, with an API
  key;
- `claude-code-local` kept on for now, with a switch that turns it off at
  once;
- Codex audited against OpenAI's documentation;
- per-provider settings, and routing aware of cost.

**What was there:**

- **claude-code-local:** `claude --print`, with stream-json and the
  agent's tools over a local MCP server. Every flag used is in the CLI
  reference: `--input-format`, `--output-format`, `--tools`,
  `--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
  `--permission-prompts`, `--system-prompt-file`, `--setting-sources`,
  `--disable-slash-commands`, `--no-session-persistence`, `--no-chrome`,
  `--model`, `--effort` and `claude auth status`.
  - **Gap, fixed:** it inherited the environment. `ANTHROPIC_API_KEY`
    there would have made Claude Code bill per token instead of using its
    sign-in.
- **codex:** `codex exec --json` and `exec resume`, every flag in
  `codex exec --help`; the app-server only for `account/read` and
  `account/rateLimits/read` (documented).
  - **Gap, fixed:** it inherited `CODEX_API_KEY` and `OPENAI_API_KEY`,
    either of which switches Codex to the API.

**Decisions:**

- **`claude-code` stays the id** (the user chose this):
  `claude-code-local` is an alias everywhere (settings, `--providers`,
  the switch, the table). Nothing to migrate, and the router's metrics are
  kept.
- **claude-api runs on the Agent SDK's `query()`.** The SDK is not
  installed with the agent: it carries a native program of about 335 MB.
  `grafeno-agent providers install claude-api` installs it, pinned
  (`@anthropic-ai/claude-agent-sdk` 0.3.316 and `@anthropic-ai/sdk`
  1.3.0), into the data folder; the user chose this. It is a
  devDependency only in the repository.
  - **Configuration:** built-in tools off (`tools: []`); the agent's tools
    through its own MCP server (`allowedTools: mcp__agent`), with
    `canUseTool` refusing anything else; `settingSources: []`; streaming
    (`includePartialMessages`); cancellation (`abortController`); turns
    resumed by session id; `maxTurns` and `maxBudgetUsd`.
  - **Environment:** only what a process needs to run, the key, and its own
    `CLAUDE_CONFIG_DIR`.
  - **The guard:** the SDK's init message says where its sign-in came from
    (`apiKeySource`); anything but `ANTHROPIC_API_KEY` stops the turn.
  - **Errors** (`rate_limit`, `authentication_failed`, `billing_error`,
    `overloaded`, the budget, the step limit) map to the agent's kinds.
    The cost (`total_cost_usd`) goes into `Usage.costUsd`.
  - **Key check:** the key is checked with the client SDK's model list,
    which spends nothing.
  - **Branding:** it is named "Claude Agent (API key)", as the SDK's
    guidelines allow, never "Claude Code".
- **Codex keeps `codex exec`.** OpenAI documents it for automation, and
  it reuses the CLI's ChatGPT sign-in.
  - The app-server is for rich clients that run their own sign-in,
    approvals and history: not needed here, where the agent owns approvals
    and history.
  - The TypeScript Codex SDK would add a dependency without a capability
    the agent lacks.
- **Switches:** every provider has `PROVIDER_<NAME>_ENABLED`, read on
  every call, ahead of the cache. Switched off, a provider is never asked
  or started, and is left out of the choice. The chat starts with the
  first one that is on.
- **Isolation:** `childEnv()` starts the official programs without any
  key variable (the agent's and the providers'). Commands the agent runs
  never see `ANTHROPIC_API_KEY`, `CODEX_API_KEY` or `OPENAI_API_KEY`
  either.
- **Cost-aware routing:** at equal fit, a provider billed per token comes
  after every subscription or free one, in Auto and in a list. It is used
  when nothing else can take the task. Tiers still follow the task, so
  light work stays on light models.

**Sources:**

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).
  It says third-party products may not offer claude.ai login, and use API
  keys instead; it also gives the branding rules.
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk),
  [app-server](https://learn.chatgpt.com/docs/app-server) and
  [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Connections: a registry, the new vendors, and /connect (2026-11-16)

The user asked for:

- Qwen, GitHub Copilot, Kimi, DeepSeek and Mistral, each as its
  documentation allows;
- API keys for OpenAI, Moonshot, Qwen, Z.ai, MiniMax and xAI;
- coding plans kept apart from API keys;
- a registry that tells vendor, connection and model apart;
- \`/connect\` in five clickable sections.

**What was there:** five connections, each a \`Provider\` built from three
parts:

- claude-code, by the CLI;
- claude-api, by the Agent SDK;
- codex, by \`codex exec\`;
- gemini and openrouter, by key.

\`/connect\` was one list of them, with Auto. The OpenAI-compatible adapter
(\`ChatCompletionsModel\`) already served OpenRouter.

**Decisions:**

- **A connection registry** (\`profiles.ts\`). Each connection has:
  - its vendor and connection type (\`cli\`, \`api-key\`, \`coding-plan\`);
  - its auth method, cost model, compliance status and whether it starts
    on;
  - what its interface supports: streaming, sessions, tools, MCP,
    cancellation and headless runs.

  \`ConnectionRecord\` (\`src/app/connections.ts\`) adds the live state:
  enabled, installed, authenticated and available. A vendor has as many
  connections as ways to reach it (Anthropic: \`claude-code-local\` and
  \`claude-api\`; Moonshot: \`kimi-code\`, \`moonshot\` and \`kimi-plan\`).
  Models belong to a connection.

- **CLIs over ACP** (Agent Client Protocol, \`src/model/acp.ts\`), one
  adapter for every vendor that documents it, on the official
  \`@agentclientprotocol/sdk\` (2.4.0, pinned):
  - Copilot: \`copilot --acp --stdio\`.
  - Qwen Code: \`qwen --acp\`.
  - Kimi Code: \`kimi acp\`.
  - Mistral Vibe: \`vibe-acp\`.

  As with Claude Code and Codex:
  - the CLI runs in a private folder, with no key variables except those
    of its own documented sign-in (Copilot's GitHub tokens);
  - the agent's tools reach it through the agent's MCP server, passed in
    \`session/new\` (an agent without HTTP MCP is refused);
  - a permission request for one of the CLI's built-in tools is refused,
    while the agent's own tools go through to the agent's approvals.

  Each turn streams (\`agent_message_chunk\`), reports its context
  (\`usage_update\`) and is cancelled with \`session/cancel\`. The session is
  kept across turns. A sign-in error (\`-32000\`) means not signed in.
  Status means \`--version\` answers and a session opens with no prompt, so
  nothing is spent.

- **Connections by key** (\`src/providers/api-key.ts\`), one adapter over
  the existing OpenAI-compatible model. No new HTTP client was written.
  - Each vendor's spec holds what its documentation says: the endpoints
    (one is chosen by \`<ID>_ENDPOINT\`, and only documented ones are
    taken), the key variable, and the free check (\`GET /models\`).
  - A balance is shown where the API reports it for free: DeepSeek's
    \`/user/balance\`, and MiniMax's plan \`/token_plan/remains\`.
  - With no model chosen, the vendor's first listed model is used.
  - Keys go to the system's secure store (\`login <connection>\`, or
    \`/connect\`), never to Grafeno, the settings file or a log, and
    commands never see their variables.
  - APIs bill per token and need \`AGENT_ALLOW_BILLING\`, asked plainly.
- **Coding plans** are separate connections with their own keys and
  endpoints, not interchangeable with API keys.
  - Z.ai and Alibaba limit their plan keys to the coding tools they list,
    and this agent is not one of them. Kimi and MiniMax do not say.
  - So all four start **off**. Switching one on asks first, and says why.
- **/connect** opens on five sections (a \`Picker\`: clickable, by number,
  or by arrows):
  - The three connection types reuse the provider panel, filtered by type,
    with search and Auto.
  - A connection by key with no key opens a masked key entry. The key is
    never shown, is checked first, and is followed by the billing or plan
    question.
  - "View connections" is the table.
  - "Manage" offers switch on or off, check now, set or change the key,
    disconnect, and allow or forbid billing.
  - \`/connect cli|api|plans|list|status|manage|disconnect <connection>\`
    go straight there.

**What is really supported:**

| Vendor    | CLI / Subscription                                           | API Key                           | Coding Plan                            | Not offered, and why                                                    |
| --------- | ------------------------------------------------------------ | --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Anthropic | Claude Code (\`claude -p\`); compliance pending              | Agent SDK (claude-api)            | —                                      | —                                                                       |
| OpenAI    | Codex (\`codex exec\`, ChatGPT sign-in)                      | Chat Completions                  | —                                      | —                                                                       |
| GitHub    | Copilot CLI over ACP (public preview)                        | —                                 | —                                      | No public pay-per-token Copilot API for this                            |
| Alibaba   | Qwen Code over ACP (its free OAuth tier ended on 2026-04-15) | Model Studio (Singapore, Beijing) | Coding Plan (restricted, off)          | —                                                                       |
| Moonshot  | Kimi Code over ACP                                           | Moonshot API (.ai, .cn)           | Kimi Code membership (unverified, off) | —                                                                       |
| Mistral   | Vibe over ACP                                                | Mistral API                       | —                                      | —                                                                       |
| Google    | —                                                            | Gemini (AI Studio)                | —                                      | Antigravity/Gemini CLI with a consumer sign-in (forbidden by the terms) |
| DeepSeek  | —                                                            | DeepSeek API                      | —                                      | No official CLI is documented                                           |
| Z.ai      | —                                                            | Z.ai API                          | GLM Coding Plan (restricted, off)      | —                                                                       |
| MiniMax   | —                                                            | MiniMax API (global, mainland)    | Coding/Token Plan (unverified, off)    | —                                                                       |
| xAI       | —                                                            | xAI API (global, US)              | —                                      | —                                                                       |

**Verified:**

- **Tests:**
  - ACP against a fake agent that is a real process, on the real SDK:
    streaming, the agent's tools over MCP, built-ins refused, the private
    folder and environment, cancellation, not signed in, no HTTP MCP;
  - the registry and the states (never "connected" for only installed);
  - connections by key with a fake vendor: the free check, refused keys,
    documented endpoints only, billing and plans, the default model, the
    balance;
  - \`login\` and the \`/connect\` actions;
  - the menu, its sections and the masked key entry.
- **Mutation-checked:** the CLI's built-ins refused, plans starting off,
  the key never shown.
- **For real:** the providers table on this machine. The CLIs are not
  installed here, and the Copilot "shim" is reported not installed.

**Sources:**

- [Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server);
- [Kimi Code: kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp);
- [Qwen Code: Zed integration](https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed);
- [Mistral Vibe in other IDEs](https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides);
- [ACP schema](https://agentclientprotocol.com/protocol/schema);
- [DeepSeek API](https://api-docs.deepseek.com/);
- [Z.ai coding tools](https://docs.z.ai/scenario-example/develop-tools/others);
- [Alibaba Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan);
- [MiniMax M Plan](https://platform.minimax.io/docs/m-plan/quickstart);
- [xAI quickstart](https://docs.x.ai/developers/quickstart).

## Open

- A Codex sign-in of the agent's own, through OpenAI's documented flow
  above, if the user wants it.
- No connection by key, and none of the new CLIs (not installed here), has
  run a real turn yet. A real turn spends the user's quota or credits, which is
  their call.
- More than one connection of the same vendor and type (two DeepSeek keys)
  is not supported yet; one key per connection.
- claude-code-local's standing awaits Anthropic's answer; if it is no,
  `providers disable claude-code-local` (or the setting) turns it off. OpenRouter's public model list was checked for real.
  `login gemini`, then a short real turn on the free tier, will show it.
