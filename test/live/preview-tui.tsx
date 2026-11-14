/**
 * Shows the interface at a given size with a scripted answer (fake memory,
 * fake model, fake provider): to look at the layout without spending any of
 * the plan.
 *
 *   npm run preview:tui -- [columns] [rows] [line…]
 *
 * Each extra argument is typed and sent after the scripted answer (a
 * message or a /command), and the screen is shown after each.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { AppServices } from "../../src/app/services.js";
import { AgentSession } from "../../src/app/session.js";
import type { Config } from "../../src/config.js";
import { FakeModel } from "../../src/model/index.js";
import type { Provider } from "../../src/providers/types.js";
import { SessionStore } from "../../src/sessions/store.js";
import { App } from "../../src/tui/app.js";
import { FakeVault } from "../memory/fake-vault.js";

const [cols = "120", lines = "40", ...inputs] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "ga-preview-"));
const config: Config = {
  grafenoMode: "included",
  grafenoUrl: "http://127.0.0.1:7811",
  agentKey: "preview-key-not-a-secret",
  namespace: "grafeno-agent",
  model: "fake",
  embedder: "none",
  palace: "shared",
  claudeEffort: "medium",
};

const ANSWER = `Here is what **src/tui** holds:

| File | Purpose |
|---|---|
| app.tsx | The interface: conversation, panels, commands |
| prompt.tsx | The box one types in, with the slash commands |
| sidebar.tsx | Model, context, plan usage, environment, memory |

\`\`\`ts
export function runTui(services: AppServices): Promise<void>
\`\`\`

- Tables, code and lists are drawn for the terminal.
- Nothing was stored in memory.`;

const provider: Provider = {
  id: "claude-code",
  name: "Claude (Claude Code)",
  signIn: "Run claude and /login.",
  status: () =>
    Promise.resolve({
      installed: true,
      signedIn: true,
      plan: "Claude Pro",
      version: "2.1.325",
      detail: "Signed in.",
    }),
  models: () =>
    Promise.resolve([
      { id: "default", name: "Opus 5.5 (default)" },
      { id: "haiku", name: "Haiku 5.5" },
      { id: "sonnet", name: "Sonnet 5.5" },
      { id: "opus", name: "Opus 5.5" },
    ]),
  efforts: () => ["low", "medium", "high", "xhigh", "max"],
  usage: () =>
    Promise.resolve({
      limits: [
        { label: "Session", used: 0.91, resets: "Nov 14, 6:20pm (America/Guayaquil)" },
        { label: "Week (all models)", used: 0.59, resets: "Nov 17, 11:59am (America/Guayaquil)" },
      ],
      at: new Date(),
      note: "Your Claude subscription",
    }),
  modelName: () => "Opus 5.5",
  create: () =>
    new FakeModel({
      turns: [[{ call: "list_files", input: { path: "src/tui" } }, { say: ANSWER }]],
    }),
};

const services: AppServices = {
  version: "0.1.0",
  settingsPath: join(dir, "config.env"),
  providers: [provider],
  needsSetup: () => false,
  start: () =>
    AgentSession.start({
      config,
      identity: { name: "grafeno-agent-dev", ownOnly: true },
      vault: new FakeVault(),
      store: new SessionStore(join(dir, "sessions")),
      cwd: process.cwd(),
      provider,
      tools: () => [
        {
          name: "list_files",
          description: "Lists files.",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          writes: false,
          run: () => "app.tsx\nprompt.tsx\nsidebar.tsx",
        },
      ],
    }),
  grafeno: () => ({
    mode: "included",
    url: config.grafenoUrl,
    namespace: config.namespace,
    hasKey: true,
    includable: true,
    installed: true,
  }),
  includeGrafeno: () => Promise.resolve(""),
  connectGrafeno: () => Promise.resolve(""),
  stopGrafeno: () => "",
  saveChoice: () => undefined,
  upkeep: () => Promise.resolve(""),
};

const app = render(<App services={services} />);
Object.defineProperty(app.stdout, "rows", { value: Number(lines), configurable: true });
Object.defineProperty(app.stdout, "columns", { value: Number(cols), configurable: true });
app.stdout.emit("resize");
const frame = () => app.lastFrame() ?? "";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
while (!frame().includes("Ask anything")) await wait(50);
await wait(800);
console.log(`----- start (${cols}×${lines}) -----\n${frame()}\n`);
for (const char of "What is in src/tui?") {
  app.stdin.write(char);
  await wait(3);
}
app.stdin.write("\r");
while (!frame().includes("Nothing was stored")) await wait(50);
await wait(300);
console.log(`----- after an answer -----\n${frame()}`);
for (const input of inputs) {
  for (const char of input) {
    app.stdin.write(char);
    await wait(3);
  }
  app.stdin.write("\r");
  await wait(900);
  console.log(`\n----- after ${input} -----\n${frame()}`);
}
app.unmount();
process.exit(0);
