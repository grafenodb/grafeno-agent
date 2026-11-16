import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AcpModel, type AcpLaunch } from "../model/acp.js";
import { childEnv } from "../model/env.js";
import { ModelError } from "../model/errors.js";
import { resilient } from "../model/index.js";
import type { Model } from "../model/types.js";
import { ComposedProvider } from "./compose.js";
import type {
  ModelCatalog,
  ModelOption,
  ProviderAuth,
  ProviderRuntime,
  ProviderStatus,
  ProviderUsage,
} from "./types.js";

/** A vendor's CLI driven over ACP, as its documentation describes it. */
export interface AcpCliSpec {
  readonly id: string;
  readonly name: string;
  /** The program, and the arguments that start its ACP server over stdio. */
  readonly command: string;
  readonly acpArgs: readonly string[];
  /** The program whose `--version` says it is installed (the same, unless its ACP server is a separate one). */
  readonly versionCommand?: string;
  /** Variables of its own documented sign-in it may see. */
  readonly keep?: readonly string[];
  readonly install: string;
  readonly signIn: string;
  readonly plan: string;
}

export const ACP_CLI_SPECS: readonly AcpCliSpec[] = [
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: "copilot",
    acpArgs: ["--acp", "--stdio"],
    // Copilot's documented ways to sign in from a script.
    keep: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    install: "npm install -g @github/copilot (or see docs.github.com: Install Copilot CLI)",
    signIn:
      "Run `copilot` in a terminal and sign in with /login (your GitHub account with Copilot).",
    plan: "Your GitHub Copilot plan",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    command: "qwen",
    acpArgs: ["--acp"],
    install: "npm install -g @qwen-code/qwen-code@latest",
    signIn:
      "Run `qwen` in a terminal and set up its sign-in with /auth (a Qwen subscription, or a key).",
    plan: "Qwen Code's own sign-in",
  },
  {
    id: "kimi-code",
    name: "Kimi Code CLI",
    command: "kimi",
    acpArgs: ["acp"],
    install: "npm install -g @moonshot-ai/kimi-code (or the installer at code.kimi.com)",
    signIn: "Run `kimi` in a terminal and sign in with /login.",
    plan: "Your Kimi Code membership",
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    command: "vibe-acp",
    acpArgs: [],
    versionCommand: "vibe",
    install: "uv tool install mistral-vibe",
    signIn: "Run `vibe` in a terminal and sign in with your Mistral account, or set its API key.",
    plan: "Your Mistral plan (or the key Vibe uses)",
  },
];

/**
 * How to start a program found on the PATH: directly, or on Windows
 * through the shell when it is a .cmd shim (npm's global installs), which
 * Node cannot start otherwise. Only fixed arguments ever go through it.
 */
export function resolveLaunch(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): AcpLaunch {
  if (platform !== "win32") return { command, args };
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (existsSync(join(dir, `${command}.exe`)))
      return { command: join(dir, `${command}.exe`), args };
    for (const ext of [".cmd", ".bat"]) {
      if (existsSync(join(dir, `${command}${ext}`))) {
        return { command: join(dir, `${command}${ext}`), args, shell: true };
      }
    }
  }
  return { command, args };
}

/** Runs a program with fixed arguments; resolves with what it printed. */
export type RunProgram = (launch: AcpLaunch, timeoutMs: number) => Promise<string>;

const runProgram: RunProgram = (launch, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      launch.command,
      [...launch.args],
      {
        cwd: tmpdir(),
        env: childEnv(),
        timeout: timeoutMs,
        windowsHide: true,
        ...(launch.shell ? { shell: true } : {}),
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`, { cause: error }));
        else resolve(`${stdout}${stderr}`);
      },
    );
  });

export interface AcpCliSettings {
  readonly run?: RunProgram;
  /** Opens and closes a session, to check the sign-in; default: a real ACP session with no prompt. */
  readonly probe?: (spec: AcpCliSpec) => Promise<void>;
  readonly model?: (spec: AcpCliSpec) => Model;
}

function launchOf(spec: AcpCliSpec): AcpLaunch {
  return {
    ...resolveLaunch(spec.command, spec.acpArgs),
    ...(spec.keep ? { keep: spec.keep } : {}),
  };
}

function modelOf(spec: AcpCliSpec): Model {
  return new AcpModel({ name: spec.name, launch: () => launchOf(spec), signIn: spec.signIn });
}

/** Opens a session over ACP and closes it: no prompt, nothing spent. */
async function probeSession(model: Model): Promise<void> {
  const conversation = await model.open({
    system: "",
    tools: { tools: [], call: () => Promise.resolve({ content: "", isError: true }) },
  });
  await conversation.close();
}

/**
 * A CLI's authentication over ACP: the program holds the sign-in. Installed
 * means its `--version` answers; signed in means its ACP server opens a
 * session (no prompt, nothing spent). Its tokens are never read.
 */
export class AcpCliAuth implements ProviderAuth {
  readonly method = "provider-cli";

  constructor(
    private readonly spec: AcpCliSpec,
    private readonly settings: AcpCliSettings,
  ) {}

  get signIn(): string {
    return this.spec.signIn;
  }

  async status(): Promise<ProviderStatus> {
    let version: string;
    try {
      const output = await (this.settings.run ?? runProgram)(
        resolveLaunch(this.spec.versionCommand ?? this.spec.command, ["--version"]),
        15_000,
      );
      version = output.trim().split("\n")[0]?.trim() ?? "";
    } catch {
      return {
        installed: false,
        signedIn: false,
        detail: `${this.spec.name} is not installed: ${this.spec.install}.`,
      };
    }
    try {
      await (this.settings.probe ?? ((spec) => probeSession(modelOf(spec))))(this.spec);
    } catch (error) {
      const setup = error instanceof ModelError && error.kind === "setup";
      return {
        installed: true,
        signedIn: false,
        version,
        detail: setup
          ? error.message
          : `${this.spec.name} could not open a session: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      installed: true,
      signedIn: true,
      version,
      plan: this.spec.plan,
      billing: { kind: "subscription", detail: this.spec.plan },
      detail: `Signed in (checked by opening a session): ${this.spec.plan.toLowerCase()}.`,
    };
  }

  /** ACP does not report a plan's quota: none is shown, none guessed. */
  usage(): Promise<ProviderUsage | undefined> {
    return Promise.resolve(undefined);
  }
}

/** A CLI's model selection over ACP: the CLI's own choice (its /model sets it). */
export class AcpCliCatalog implements ModelCatalog {
  readonly tiers = { deep: ["default"], standard: ["default"], light: ["default"] } as const;

  constructor(private readonly spec: AcpCliSpec) {}

  models(): Promise<readonly ModelOption[]> {
    return Promise.resolve([
      {
        id: "default",
        name: "Auto",
        hint: `${this.spec.name}'s own choice (set it with its /model)`,
      },
    ]);
  }

  efforts(): readonly string[] {
    return [];
  }

  modelName(id: string): string {
    return id === "default" ? `${this.spec.name} (its model)` : id;
  }
}

/** A CLI's execution over ACP: its ACP server, with the agent's tools over MCP. */
export class AcpCliRuntime implements ProviderRuntime {
  readonly features = {
    agentTools: true,
    streaming: true,
    keepsConversation: true,
    usageReport: false,
    nonInteractive: true,
  } as const;

  constructor(
    private readonly spec: AcpCliSpec,
    private readonly settings: AcpCliSettings,
  ) {}

  /** Its model is the CLI's own choice: the choice made here does not reach it. */
  create(): Model {
    return resilient((this.settings.model ?? modelOf)(this.spec));
  }
}

/** A vendor's CLI over ACP: its three parts, as one connection. */
export class AcpCliProvider extends ComposedProvider {
  constructor(spec: AcpCliSpec, settings: AcpCliSettings = {}) {
    super(spec.id, spec.name, {
      auth: new AcpCliAuth(spec, settings),
      catalog: new AcpCliCatalog(spec),
      runtime: new AcpCliRuntime(spec, settings),
    });
  }
}
