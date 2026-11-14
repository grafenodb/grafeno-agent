/**
 * Drives the real interface (real Grafeno, real Claude Code) with keys, and
 * prints what the screen shows: to look at a real answer in the layout.
 * Spends a little of the plan: one short turn on the model in CLAUDE_MODEL.
 *
 *   CLAUDE_MODEL=haiku npx tsx test/live/drive-tui.tsx "your message" [columns] [rows]
 */
import { render } from "ink-testing-library";
import { realServices } from "../../src/app/services.js";
import { loadSettings } from "../../src/settings-file.js";
import { App } from "../../src/tui/app.js";

loadSettings({ fromSource: true });
const [message = "hello", cols = "120", lines = "45"] = process.argv.slice(2);
const app = render(<App services={realServices("0.1.0")} />);
Object.defineProperty(app.stdout, "rows", { value: Number(lines), configurable: true });
Object.defineProperty(app.stdout, "columns", { value: Number(cols), configurable: true });
app.stdout.emit("resize");

const frame = () => app.lastFrame() ?? "";
async function until(check: () => boolean, what: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await until(() => frame().includes("Ask anything") && frame().includes("Session"), "the prompt");
await new Promise((resolve) => setTimeout(resolve, 200));
for (const char of message) {
  app.stdin.write(char);
  await new Promise((resolve) => setTimeout(resolve, 3));
}
app.stdin.write("\r");
await until(() => frame().includes("Working"), "the turn to start", 10_000);
let mid = "";
await until(() => {
  if (mid === "" && frame().includes("✓")) mid = frame();
  return frame().includes("Ask anything");
}, "the answer");
await new Promise((resolve) => setTimeout(resolve, 1500));
if (mid !== "") console.log(`----- during the turn -----\n${mid}\n`);
console.log(`----- after the answer -----\n${frame()}`);
app.unmount();
process.exit(0);
