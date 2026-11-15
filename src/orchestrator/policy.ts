import type { Approver, PermissionDecision, Tool } from "../agent/tools.js";

/** How much a run may do without asking. */
export const AUTONOMY = ["supervised", "controlled", "extended"] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export interface Verdict {
  readonly decision: "allow" | "ask" | "never";
  readonly reason: string;
}

/** A question for a person: a worker wants to do something the policy does not allow alone. */
export interface Question {
  readonly worker?: string;
  readonly task?: string;
  readonly action: string;
  readonly reason: string;
}

/** Actions of the run itself, beyond a worker's tools. */
export type RunAction =
  | "merge-integration" // a task's branch into the run's integration branch
  | "merge-user" // the integration branch into the user's branch
  | "push"
  | "deploy"
  | "secrets"
  | "outside-project";

/** Commands that ask in every mode: they reach beyond the worktree, or cannot be undone. */
const SENSITIVE: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b/i, reason: "it publishes changes" },
  {
    pattern: /\b(npm|pnpm|yarn|cargo|twine|gem)\s+publish\b|\bdotnet\s+nuget\s+push\b/i,
    reason: "it publishes a package",
  },
  { pattern: /\b(docker|podman)\s+(push|login)\b/i, reason: "it publishes an image" },
  {
    pattern:
      /\b(kubectl|helm|terraform|pulumi|ansible-playbook|aws|gcloud|az|doctl|flyctl|vercel|netlify|heroku)\b/i,
    reason: "it acts on infrastructure",
  },
  { pattern: /\b(firebase|serverless|sls|wrangler)\s+deploy\b|\bdeploy\b/i, reason: "it deploys" },
  { pattern: /\b(ssh|scp|sftp|rsync)\b/i, reason: "it reaches another computer" },
  {
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+--source)/i,
    reason: "it throws work away",
  },
  { pattern: /(^|[\s;&|])rm\s+-[a-z]*r/i, reason: "it deletes folders" },
  { pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i, reason: "it deletes data" },
];

/** Commands `controlled` runs without asking: checks and builds, alone (not chained). */
export const CHECK_COMMANDS: readonly RegExp[] = [
  /^(npm|pnpm|yarn)\s+(test|ci|install|i|run\s+[\w:.-]+|exec\s+[\w@/.-]+)(\s+[\w@/.:=,-]+)*$/,
  /^npx\s+(--no-install\s+)?(tsc|vitest|jest|eslint|prettier|tsx|ts-node|playwright|biome)(\s+[\w@/.:=,*-]+)*$/,
  /^(tsc|vitest|jest|eslint|prettier|biome)(\s+[\w@/.:=,*-]+)*$/,
  /^node\s+[\w./-]+\.(m?js|cjs|ts)(\s+[\w@/.:=,-]+)*$/,
  /^node\s+--test(\s+[\w@/.:=,*-]+)*$/,
  /^(python3?\s+-m\s+)?(pytest|unittest|mypy|ruff|black)(\s+[\w@/.:=,-]+)*$/,
  /^cargo\s+(test|build|check|clippy|fmt)(\s+[\w@/.:=,-]+)*$/,
  /^go\s+(test|build|vet)(\s+[\w@/.:=,-]+)*$/,
  /^dotnet\s+(test|build|format)(\s+[\w@/.:=,-]+)*$/,
  /^(mvn|gradle|\.\/gradlew)\s+(test|build|check|verify|compile)(\s+[\w@/.:=,-]+)*$/,
  /^make(\s+(test|build|check|lint))?$/,
  /^git\s+(add|commit)\b(?!.*--amend)/,
];

/** Shell characters that let one command become several. */
const COMPOUND = /[;&|<>`]|\$\(|\r|\n/;

const FILE_WRITES = new Set(["write_file", "edit_file"]);

export interface PolicyOptions {
  readonly mode: Autonomy;
  /** Commands `controlled` allows; default: `CHECK_COMMANDS`. */
  readonly checkCommands?: readonly RegExp[];
}

/**
 * The run's policy, in code: what a worker may do alone, what needs a
 * person, what never happens. It is consulted for every tool call the tool
 * itself would ask about (calls a tool forbids stay forbidden in every
 * mode) and for the run's own actions. A model cannot argue with it.
 */
export class Policy {
  readonly mode: Autonomy;
  readonly #checks: readonly RegExp[];

  constructor(options: PolicyOptions) {
    this.mode = options.mode;
    this.#checks = options.checkCommands ?? CHECK_COMMANDS;
  }

  /** A tool call, given what the tool itself decided about it. */
  tool(
    tool: Pick<Tool, "name">,
    input: Record<string, unknown>,
    own: PermissionDecision,
    ownChecks: readonly string[] = [],
  ): Verdict {
    if (own.permission === "never")
      return { decision: "never", reason: own.reason ?? "the tool refuses it" };
    if (own.permission === "free")
      return { decision: "allow", reason: own.reason ?? "it only reads" };
    if (FILE_WRITES.has(tool.name)) {
      return this.mode === "supervised"
        ? { decision: "ask", reason: "supervised: every change is asked" }
        : { decision: "allow", reason: "it writes in the task's own worktree" };
    }
    if (tool.name === "run_command")
      return this.command(typeof input.command === "string" ? input.command : "", ownChecks);
    if (tool.name === "web_fetch") {
      return this.mode === "extended"
        ? { decision: "allow", reason: "extended: reading the web is allowed" }
        : { decision: "ask", reason: "it reaches the internet" };
    }
    return this.mode === "extended"
      ? { decision: "allow", reason: "extended" }
      : { decision: "ask", reason: own.reason ?? "it needs permission" };
  }

  /**
   * A command a worker wants to run in its worktree. `ownChecks` are the
   * commands of its task's acceptance: the verifier runs them anyway, so in
   * `controlled` the worker may run them too, exactly as written, to check
   * its own work before it says it is done.
   */
  command(command: string, ownChecks: readonly string[] = []): Verdict {
    const trimmed = command.trim();
    const sensitive = SENSITIVE.find((rule) => rule.pattern.test(trimmed));
    if (sensitive) return { decision: "ask", reason: `${sensitive.reason}: always asked` };
    if (this.mode === "supervised")
      return { decision: "ask", reason: "supervised: every command is asked" };
    if (this.mode === "extended")
      return { decision: "allow", reason: "extended: commands in the worktree" };
    if (ownChecks.some((check) => check.trim() === trimmed)) {
      return { decision: "allow", reason: "one of the task's own checks" };
    }
    if (!COMPOUND.test(trimmed) && this.#checks.some((pattern) => pattern.test(trimmed))) {
      return { decision: "allow", reason: "a check or a build" };
    }
    return { decision: "ask", reason: "controlled: only checks and builds run without asking" };
  }

  /** One of the run's own actions. */
  action(action: RunAction): Verdict {
    switch (action) {
      case "merge-integration":
        return this.mode === "supervised"
          ? { decision: "ask", reason: "supervised: merges are asked" }
          : {
              decision: "allow",
              reason: "the task's checks passed; the integration branch is the run's own",
            };
      case "merge-user":
        return this.mode === "extended"
          ? { decision: "allow", reason: "extended: merged when every check passes" }
          : { decision: "ask", reason: "your branch changes only when you say so" };
      case "push":
      case "deploy":
      case "secrets":
      case "outside-project":
        return { decision: "ask", reason: `${action} is always asked` };
    }
  }

  /**
   * The policy as an approver for a worker's tools. A call it allows runs; a
   * call it refuses never does; a call it would ask about goes to `ask`
   * (a person, through the interface), or is refused when there is no one
   * to ask, and the question is recorded either way.
   */
  approver(
    who: { worker?: string; task?: string },
    ask?: (question: Question) => Promise<boolean>,
    record?: (question: Question, answer: boolean | "nobody") => void,
    ownChecks: readonly string[] = [],
  ): Approver {
    return async (call, tool, decision) => {
      const verdict = this.tool(tool, call.input, decision, ownChecks);
      if (verdict.decision === "allow") return true;
      if (verdict.decision === "never") return false;
      const question: Question = {
        ...who,
        action: tool.describe
          ? tool.describe(call.input)
          : `${call.name} ${JSON.stringify(call.input)}`,
        reason: verdict.reason,
      };
      if (!ask) {
        record?.(question, "nobody");
        return false;
      }
      const answer = await ask(question);
      record?.(question, answer);
      return answer;
    };
  }
}
