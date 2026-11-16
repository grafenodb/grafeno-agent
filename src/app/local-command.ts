import { connectionActions } from "./connections.js";
import { updateSettings } from "../settings-file.js";
import { describeModel } from "../providers/local/discover.js";
import { localityText } from "../providers/local/endpoint.js";
import {
  LOCAL_KINDS,
  LOCAL_KIND_INFO,
  loadLocalConnections,
  localConnectionsFile,
  type LocalKind,
} from "../providers/local/store.js";

export interface LocalCommandIo {
  readonly say: (line: string) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly file?: string;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const USAGE = [
  "grafeno-agent local                                  the local and self-hosted connections",
  "grafeno-agent local add <kind> <url> [--id i] [--model m] [--key-env VAR]",
  `                                                     kinds: ${LOCAL_KINDS.join(", ")}`,
  "grafeno-agent local check <id>                       what it answers, its models and what each can do",
  "grafeno-agent local model <id> <model>               its default model",
  "grafeno-agent local remove <id> [--yes]              remove it (ollama and lmstudio go back to their defaults)",
];

/**
 * `grafeno-agent local`: the person's model servers from a terminal. A key
 * is never typed on the command line (it would stay in the shell's
 * history): `--key-env` names the variable that holds it.
 */
export async function localCommand(argv: readonly string[], io: LocalCommandIo): Promise<number> {
  const env = io.env ?? process.env;
  const file = io.file ?? localConnectionsFile(env);
  const actions = connectionActions({
    env,
    save: (values) => {
      updateSettings(values);
    },
    localFile: file,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  const sub = argv[0] ?? "list";
  if (sub === "list" || sub === "ls") {
    for (const c of loadLocalConnections(file)) {
      io.say(
        `  ${c.id.padEnd(16)} ${c.name.padEnd(28)} ${c.url}${c.defaultModel ? `  · ${c.defaultModel}` : ""}${c.hasKey ? "  · key" : ""}`,
      );
    }
    io.say("grafeno-agent local check <id> shows what one offers.");
    return 0;
  }
  if (sub === "add") {
    const kind = argv[1] as LocalKind | undefined;
    const url = argv[2] ?? (kind ? LOCAL_KIND_INFO[kind].defaultUrl : undefined);
    if (!kind || !(LOCAL_KINDS as readonly string[]).includes(kind) || !url) {
      for (const line of USAGE) io.say(line);
      return 2;
    }
    const keyVariable = flag(argv, "--key-env");
    const key = keyVariable ? env[keyVariable]?.trim() : undefined;
    if (keyVariable && !key) {
      io.say(`${keyVariable} is empty: nothing changed.`);
      return 1;
    }
    if (LOCAL_KIND_INFO[kind].key === "required" && !key) {
      io.say(`${LOCAL_KIND_INFO[kind].name} needs a key: --key-env <VARIABLE that holds it>.`);
      return 2;
    }
    const checked = await actions.checkServer(kind, url, key);
    if (!checked.ok) {
      io.say(
        `${checked.message}${checked.needsKey ? " Give its key with --key-env <VARIABLE>." : ""} Nothing changed.`,
      );
      return 1;
    }
    io.say(
      `${LOCAL_KIND_INFO[kind].name}${checked.found.version ? ` ${checked.found.version}` : ""} answers at ${checked.url} (${localityText(checked.locality)}): ${String(checked.found.models.length)} models.`,
    );
    const model = flag(argv, "--model");
    if (model && !checked.found.models.some((m) => m.id === model)) {
      io.say(`It lists no model ${model}: nothing changed.`);
      return 1;
    }
    const id = flag(argv, "--id");
    const saved = await actions.saveServer({
      kind,
      url: checked.url,
      locality: checked.locality,
      ...(id ? { id } : {}),
      ...(key ? { key } : {}),
      ...(model ? { defaultModel: model } : {}),
    });
    io.say(saved.message);
    return 0;
  }
  const id = argv[1] ?? "";
  const connection = loadLocalConnections(file).find((c) => c.id === id);
  if ((sub === "check" || sub === "model" || sub === "remove") && !connection) {
    io.say(`No local connection is named ${id}: grafeno-agent local lists them.`);
    return 1;
  }
  if (sub === "check" && connection) {
    const checked = await actions.checkServer(connection.kind, connection.url);
    if (!checked.ok) {
      io.say(checked.message);
      return 1;
    }
    io.say(
      `${connection.name}${checked.found.version ? ` ${checked.found.version}` : ""} at ${checked.url} (${localityText(checked.locality)})${checked.found.latencyMs === undefined ? "" : `, answered in ${String(checked.found.latencyMs)} ms`}:`,
    );
    for (const m of checked.found.models) {
      io.say(`  ${m.id === connection.defaultModel ? "★" : "·"} ${m.id}  ${describeModel(m)}`);
    }
    if (checked.found.models.length === 0) io.say("  no model yet");
    return 0;
  }
  if (sub === "model" && connection) {
    const model = argv[2];
    if (!model) {
      io.say("Which model? grafeno-agent local model <id> <model>");
      return 2;
    }
    io.say(actions.setServerModel(connection.id, model));
    return 0;
  }
  if (sub === "remove" && connection) {
    if (
      !argv.includes("--yes") &&
      !(await io.confirm(`Remove ${connection.name} (${connection.url})?`))
    ) {
      io.say("Kept.");
      return 0;
    }
    io.say(await actions.removeServer(connection.id));
    return 0;
  }
  for (const line of USAGE) io.say(line);
  return 2;
}
