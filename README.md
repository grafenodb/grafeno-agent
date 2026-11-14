# Grafeno Agent

A programming assistant with long-term memory. Its reasoning comes from a
language model that can be swapped; what it knows is kept in
[Grafeno](https://github.com/grafenodb/grafeno), through
[`@grafenodb/client`](https://www.npmjs.com/package/@grafenodb/client).
The plan is in [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 22.18 or later (what `@grafenodb/client` needs).
- A Grafeno server, and a key of the agent's own made by its administrator.
- For the first model: Claude Code installed and logged in.

## Set up

```bash
npm install
cp .env.example .env
```

An administrator makes the agent's key on the Grafeno server; the secret
is printed once:

```bash
grafeno keys create grafeno-agent --grant grafeno-agent:write --config grafeno.toml
```

Put it in `.env` as `GRAFENO_AGENT_KEY`. Never commit `.env`.

| Variable            | Default                 | What                                            |
| ------------------- | ----------------------- | ----------------------------------------------- |
| `GRAFENO_URL`       | `http://127.0.0.1:7810` | The Grafeno server                              |
| `GRAFENO_AGENT_KEY` | (required)              | The agent's key                                 |
| `GRAFENO_NAMESPACE` | `grafeno-agent`         | Where the agent keeps its memory                |
| `AGENT_MODEL`       | `claude-code`           | The model adapter (`claude-code`: subscription) |

Then check that Grafeno answers and the key works:

```bash
npm run check
```

## Development

```bash
npm run ci         # typecheck, lint, format check, tests, build
npm test           # unit tests, no server needed
npm run test:live  # against the Grafeno server in .env
```
