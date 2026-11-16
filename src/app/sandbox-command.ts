import { resolve } from "node:path";
import type { SandboxManager } from "../sandbox/manager.js";
import { keepPolicy, networkSetting, sandboxMode } from "../sandbox/policy.js";

const MODE_TEXT = {
  auto: "auto: commands run in the sandbox where this computer has one",
  required: "required: a command that cannot be sandboxed does not run",
  off: "off: commands run on this computer, with your rights (AGENT_SANDBOX=off)",
} as const;

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const SANDBOX_USAGE = [
  "/sandbox status                what isolates commands here, and what does not",
  "/sandbox list                  the sandboxes kept",
  "/sandbox create [folder]       a sandbox for a folder (the project by default)",
  "/sandbox inspect <id>          one sandbox: its folders, size and security events",
  "/sandbox stop <id>             end what runs in it (it stays)",
  "/sandbox destroy <id>          end it and remove it",
  "/sandbox cleanup               remove every sandbox where nothing runs",
];

/**
 * `/sandbox` and `grafeno-agent sandbox`: Grafeno Sandbox's state and its
 * sandboxes, in lines for a person. Sandboxes are made by themselves when
 * commands run; these are for looking and tidying up.
 */
export async function sandboxCommand(
  args: readonly string[],
  manager: SandboxManager,
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<{ title: string; lines: string[]; ok: boolean }> {
  const env = options.env ?? process.env;
  const sub = args[0] ?? "status";
  const id = args[1] ?? "";
  switch (sub) {
    case "status": {
      const report = await manager.report(true);
      const mode = sandboxMode(env);
      const kept = manager.list();
      const lines = [
        `Mode: ${MODE_TEXT[mode]}`,
        report.available
          ? `Engine: ${report.engine} · ${report.mechanisms.join(" · ")}`
          : `Engine: none available here: ${report.reason ?? "unknown"}.`,
        ...(report.available
          ? []
          : [
              mode === "required"
                ? "Commands do not run: the sandbox is required and there is none."
                : mode === "auto"
                  ? "Commands run on this computer, with your rights; every command's result says so."
                  : "",
            ].filter(Boolean)),
        `Network: ${networkSetting(env) === "auto" ? "only for commands that install or fetch (npm install, pip install, git clone…)" : networkSetting(env)} · kept when done: ${keepPolicy(env)}`,
        "",
        "What goes through it: the agent's run_command and start_process, and a run's checks, for every provider. Provider CLIs (Claude Code, Codex, ACP agents) run on this computer, with their own tools off: the commands they ask for are the agent's, and run here. The agent's file tools (read, write, edit) run in the agent, kept to the project's folder by its own checks, not by the sandbox.",
        ...(report.limitations.length > 0
          ? ["", "Limitations here:", ...report.limitations.map((l) => `- ${l}`)]
          : []),
        "",
        `Sandboxes kept: ${String(kept.length)}${kept.some((s) => s.running > 0) ? ` (${String(kept.filter((s) => s.running > 0).length)} running)` : ""} · in ${manager.dir}`,
      ];
      return { title: "Grafeno Sandbox", lines, ok: true };
    }
    case "list": {
      const kept = manager.list();
      return {
        title: "Sandboxes",
        lines:
          kept.length === 0
            ? ["None kept. They are made when commands run, and removed when done."]
            : kept.map(
                (s) =>
                  `${s.id}  ${s.label.padEnd(16)} ${s.created.slice(0, 16).replace("T", " ")}  ${s.running > 0 ? `${String(s.running)} running` : s.stopped ? "stopped" : "idle"}  ${s.workspace}`,
              ),
        ok: true,
      };
    }
    case "create": {
      const folder = resolve(options.cwd ?? process.cwd(), id || ".");
      const made = manager.create({ label: "manual", workspace: folder, keep: "always" });
      const report = await manager.report();
      return {
        title: "Sandbox made",
        lines: [
          `${made.id} for ${folder}`,
          `Its home: ${made.home} · its temporary folder: ${made.tmp}`,
          report.available
            ? "Commands in it may write only there and in the folder; nothing of your home is in it."
            : `This computer has no engine (${report.reason ?? "none"}): commands in it are not isolated.`,
          `It is kept until /sandbox destroy ${made.id}.`,
        ],
        ok: true,
      };
    }
    case "inspect": {
      const found = manager.inspect(id);
      if (!found)
        return { title: "Sandbox", lines: [`No sandbox ${id}: /sandbox list.`], ok: false };
      const s = found.state;
      return {
        title: `Sandbox ${s.id}`,
        lines: [
          `For: ${s.label} · made ${s.created.slice(0, 19).replace("T", " ")} · ${s.running > 0 ? `${String(s.running)} running` : s.stopped ? "stopped" : "idle"}`,
          `Work folder (writable): ${s.workspace}`,
          ...s.writable.map((w) => `Also writable: ${w}`),
          `Home: ${s.home} · temporary: ${s.tmp} · size ${size(found.size)}`,
          `Kept when done: ${s.keep}`,
          "",
          "Security events (newest last; never commands' text, output or secrets):",
          ...(found.events.length > 0 ? found.events : ["none yet"]),
        ],
        ok: true,
      };
    }
    case "stop":
      return manager.stop(id)
        ? { title: "Sandbox", lines: [`Everything in ${id} was ended; it stays.`], ok: true }
        : { title: "Sandbox", lines: [`No sandbox ${id}.`], ok: false };
    case "destroy":
      return manager.destroy(id)
        ? { title: "Sandbox", lines: [`${id} was ended and removed.`], ok: true }
        : { title: "Sandbox", lines: [`No sandbox ${id}.`], ok: false };
    case "cleanup": {
      const removed = manager.cleanup();
      return {
        title: "Sandboxes",
        lines: [
          `${String(removed)} sandbox${removed === 1 ? "" : "es"} removed (none where something runs).`,
        ],
        ok: true,
      };
    }
    default:
      return { title: "Sandbox", lines: SANDBOX_USAGE, ok: false };
  }
}
