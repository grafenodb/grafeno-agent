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

## Open

- A Codex sign-in of the agent's own, through OpenAI's documented flow
  above, if the user wants it.
- Gemini has not been run for real yet: no key is set up on this machine.
  `login gemini`, then a short real turn on the free tier, will show it.
