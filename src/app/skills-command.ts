import { homedir } from "node:os";
import { join } from "node:path";
import { runSkills, safeArgument, skillsArguments } from "../skills/cli.js";
import { findSkills, newSkill, skillRoots, type SkillScan } from "../skills/skills.js";

export interface SkillsCommandOptions {
  /** The project's folder: a project install lands in its .agents/skills. */
  readonly cwd: string;
  readonly say: (line: string) => void;
  /** Runs the Skills CLI; default: the official one, through npx. */
  readonly run?: (args: readonly string[], cwd: string) => Promise<number>;
  readonly home?: string;
}

/** The installed skills, as lines for a person: each with where it is from, and any problem. */
export function describeSkills(scan: SkillScan): string[] {
  const lines =
    scan.skills.length === 0
      ? ["No skills yet."]
      : [
          `Skills (${String(scan.skills.length)}):`,
          ...scan.skills.flatMap((s) => [
            `  ${s.name.padEnd(24)} ${s.scope === "project" ? "project" : "yours  "}  ${firstLine(s.description, 70)}`,
            `  ${" ".repeat(24)} ${s.location}`,
          ]),
        ];
  if (scan.problems.length > 0) {
    lines.push("", "Problems:", ...scan.problems.map((p) => `  ${p}`));
  }
  return lines;
}

const USAGE = `grafeno-agent skills                      the skills the agent can use, and any problem
grafeno-agent skills add <source> [-g]    install with the Skills CLI (npx skills): owner/repo,
                                          a URL or a path; --skill <name> picks one; -g for all
                                          your projects (~/.config/agents/skills)
grafeno-agent skills find [query]         search skills to install (npx skills find)
grafeno-agent skills remove <name> [-g]   remove an installed skill
grafeno-agent skills update [-g]          update installed skills
grafeno-agent skills new <name> --description "<what it does and when to use it>" [-g]
                                          a skill of your own, to fill in (SKILL.md)
grafeno-agent skills check                the same list; exits 1 when a skill has a problem`;

/**
 * `grafeno-agent skills …`: the skills the agent reads, installing others
 * with the official Skills CLI (for its `universal` agent, whose folders
 * the agent reads), and writing your own.
 */
export async function skillsCommand(
  args: readonly string[],
  options: SkillsCommandOptions,
): Promise<number> {
  const { say, cwd } = options;
  const home = options.home ?? (process.env.AGENT_SKILLS_HOME?.trim() || homedir());
  const run = options.run ?? runSkills;
  const global = args.includes("-g") || args.includes("--global");
  const rest = args.slice(1).filter((a) => a !== "-g" && a !== "--global");
  const scan = () => findSkills(skillRoots(cwd, home));
  const show = () => {
    for (const line of describeSkills(scan())) say(line);
  };
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      show();
      return 0;
    case "check": {
      const found = scan();
      for (const line of describeSkills(found)) say(line);
      return found.problems.length > 0 ? 1 : 0;
    }
    case "add": {
      const source = rest[0];
      const picked = flagValues(rest, "--skill");
      if (!source || !safeArgument(source) || !picked.every(safeArgument)) {
        say("Say where from: grafeno-agent skills add owner/repo [--skill name] [-g]");
        return 2;
      }
      say(
        `Installing with the Skills CLI (npx skills), for ${global ? "all your projects" : "this project"}…`,
      );
      const code = await run(skillsArguments({ kind: "add", source, skills: picked }, global), cwd);
      if (code !== 0) {
        say(`The Skills CLI ended with code ${String(code)}: see above. Nothing else changed.`);
        return code;
      }
      show();
      return 0;
    }
    case "remove":
    case "rm": {
      const name = rest[0];
      if (!name || !safeArgument(name)) {
        say("Say which: grafeno-agent skills remove <name> [-g]");
        return 2;
      }
      return run(skillsArguments({ kind: "remove", name }, global), cwd);
    }
    case "find": {
      const query = rest.join(" ").trim();
      if (query !== "" && !safeArgument(query.replace(/ /g, "-"))) {
        say("Search with words, letters and digits.");
        return 2;
      }
      return run(skillsArguments({ kind: "find", ...(query ? { query } : {}) }, global), cwd);
    }
    case "update":
      return run(skillsArguments({ kind: "update" }, global), cwd);
    case "new": {
      const name = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--description");
      const description = flagValues(rest, "--description")[0] ?? "";
      if (!name) {
        say(USAGE);
        return 2;
      }
      const root = global ? join(home, ".agents", "skills") : join(cwd, ".agents", "skills");
      const made = newSkill(root, name, description);
      if (!made.ok) {
        say(`Not made: ${made.reason}.`);
        return 2;
      }
      say(
        `Made ${made.location}: write its steps there. The agent uses it when a task matches its description.`,
      );
      return 0;
    }
    default:
      say(USAGE);
      return sub === "help" || sub === "--help" ? 0 : 2;
  }
}

function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === flag && args[i + 1] !== undefined) out.push(args[++i] ?? "");
    else if (arg.startsWith(`${flag}=`)) out.push(arg.slice(flag.length + 1));
  }
  return out;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
