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

- **`AGENT_AUTO_PROVIDERS`** lists what Auto includes. Empty means the
  providers used through their official CLI (`claude-code`, `codex`).
  Providers reached with an API key (`API_KEY_PROVIDERS`: `gemini`,
  `openrouter`) are only in it when the user names them.
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

## Open

- A Codex sign-in of the agent's own, through OpenAI's documented flow
  above, if the user wants it.
- Gemini and OpenRouter have not been run for real yet: no key is set up
  on this machine. OpenRouter's public model list was checked for real.
  `login gemini`, then a short real turn on the free tier, will show it.
