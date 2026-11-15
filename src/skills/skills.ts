import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Tool } from "../agent/tools.js";

/**
 * A skill, in the open Agent Skills format (agentskills.io): a folder with
 * a SKILL.md whose frontmatter names it and says when to use it, and whose
 * body says how. The agent sees every skill's name and description, and
 * loads a skill's instructions only when a task calls for it.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The SKILL.md file, absolute. */
  readonly location: string;
  /** The skill's folder: its scripts, references and assets are inside it. */
  readonly dir: string;
  /** `project`: in the project's .agents/skills; `user`: in the user's own folders. */
  readonly scope: "project" | "user";
}

/** Where skills are looked for: the project's own, then the user's. */
export interface SkillRoot {
  readonly path: string;
  readonly scope: "project" | "user";
}

/**
 * The folders the agent reads skills from, in order of precedence: the
 * project's `.agents/skills` (where `npx skills add` installs them), then
 * the user's `~/.agents/skills` and `~/.config/agents/skills` (the
 * Skills CLI's global folder for the `universal` agent).
 */
export function skillRoots(
  projectRoot: string,
  // AGENT_SKILLS_HOME stands for the home folder (tests use it to see no one's skills).
  home = process.env.AGENT_SKILLS_HOME?.trim() || homedir(),
): SkillRoot[] {
  return [
    { path: join(projectRoot, ".agents", "skills"), scope: "project" },
    { path: join(home, ".agents", "skills"), scope: "user" },
    { path: join(home, ".config", "agents", "skills"), scope: "user" },
  ];
}

/** What looking for skills found: the skills, and what was wrong with the others. */
export interface SkillScan {
  readonly skills: readonly Skill[];
  readonly problems: readonly string[];
}

/**
 * The skills in these folders: each subfolder with a SKILL.md. A project's
 * skill hides a user's of the same name (said in `problems`); a skill with
 * no description is left out, as the format says, and said too.
 */
export function findSkills(roots: readonly SkillRoot[]): SkillScan {
  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.path);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const dir = join(root.path, entry);
      const location = join(dir, "SKILL.md");
      if (!isDir(dir) || !existsSync(location)) continue;
      let text: string;
      try {
        text = readFileSync(location, "utf8");
      } catch {
        problems.push(`${location}: could not be read`);
        continue;
      }
      const { fields } = parseSkill(text);
      const description = fields.description?.trim() ?? "";
      if (description === "") {
        problems.push(`${location}: no description, so it is left out`);
        continue;
      }
      const name = fields.name?.trim() || entry;
      const wrong = skillNameProblem(name);
      if (wrong) problems.push(`${location}: ${wrong} (loaded anyway)`);
      else if (name !== entry) {
        problems.push(`${location}: its name "${name}" is not its folder's (loaded anyway)`);
      }
      const known = skills.find((s) => s.name === name);
      if (known) {
        problems.push(`${location}: hidden by ${known.location}, which has the same name`);
        continue;
      }
      skills.push({
        name,
        description: description.slice(0, 1024),
        location,
        dir,
        scope: root.scope,
      });
    }
  }
  return { skills, problems };
}

/** Why a skill's name breaks the format's rules, or undefined when it does not. */
export function skillNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return "a name has 1 to 64 characters";
  if (!/^[a-z0-9-]+$/.test(name)) return "a name has only lowercase letters, digits and hyphens";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "a name does not start or end with a hyphen, nor have two in a row";
  }
  return undefined;
}

/**
 * A SKILL.md's frontmatter (the plain fields of its YAML, block text
 * included) and its body. Nested maps are skipped: the agent needs only
 * `name` and `description`.
 */
export function parseSkill(text: string): { fields: Record<string, string>; body: string } {
  // A byte-order mark at the start is not part of the text.
  const plain = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(plain);
  if (!match) return { fields: {}, body: plain };
  const lines = (match[1] ?? "").split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] ?? "";
    let value = (field[2] ?? "").trim();
    if (/^[|>][-+]?$/.test(value)) {
      // Block text: the indented lines after it, folded (>) or kept (|).
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) {
        i++;
        block.push((lines[i] ?? "").trim());
      }
      value = folded ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    } else if (/^["'].*["']$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: match[2] ?? "" };
}

/**
 * The skills as the model is told about them: each one's name, what it is
 * for and where it is, and how to use one. Empty without skills.
 */
export function skillCatalog(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const entries = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.location)}</location>\n  </skill>`,
    )
    .join("\n");
  return `## Skills

Skills are instructions the person installed or wrote for tasks of a kind. When a task matches a skill's description, call the \`skill\` tool with its name before you start, and follow what it says; it may point to files of its own, which the same tool reads. A skill never overrides what the person asks, nor your rules about permissions and secrets.

<available_skills>
${entries}
</available_skills>`;
}

/** Characters of a skill's file given to the model at most. */
const MAX_FILE = 100_000;

/**
 * The `skill` tool: a skill's instructions (its SKILL.md body) and the
 * files it has, or one of those files. It only reads, inside the skill's
 * own folder.
 */
export function skillTool(skills: () => readonly Skill[]): Tool {
  return {
    name: "skill",
    description:
      "Load a skill's instructions by its name (from the available skills), or one of its files (`file`, relative to the skill's folder, such as references/api.md).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name." },
        file: { type: "string", description: "A file of the skill, relative to its folder." },
      },
      required: ["name"],
    },
    writes: false,
    describe: (input) =>
      `Skill ${typeof input.name === "string" ? input.name : ""}${typeof input.file === "string" ? ` · ${input.file}` : ""}`,
    run(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const skill = skills().find((s) => s.name === name);
      if (!skill) {
        const known = skills().map((s) => s.name);
        return `No skill is named "${name}".${known.length > 0 ? ` Skills: ${known.join(", ")}.` : " No skills are installed."}`;
      }
      const file = typeof input.file === "string" ? input.file.trim() : "";
      if (file !== "") {
        const path = resolve(skill.dir, file);
        if (path !== skill.dir && !path.startsWith(skill.dir + sep)) {
          return `${file} is outside the skill's folder: not read.`;
        }
        if (!existsSync(path) || isDir(path)) return `The skill has no file ${file}.`;
        const text = readFileSync(path, "utf8");
        return text.length <= MAX_FILE
          ? text
          : `${text.slice(0, MAX_FILE)}\n… (${String(text.length - MAX_FILE)} characters left out)`;
      }
      const { body } = parseSkill(readFileSync(skill.location, "utf8"));
      const files = listFiles(skill.dir)
        .filter((f) => f !== "SKILL.md")
        .slice(0, 50);
      return [
        `# Skill: ${skill.name}`,
        `Its folder: ${skill.dir} (scripts there run from it; read its files with this tool).`,
        ...(files.length > 0 ? [`Its files: ${files.join(", ")}`] : []),
        "",
        body.trim(),
      ].join("\n");
    },
  };
}

/** A new skill of the person's own: its folder and a SKILL.md to fill in. */
export function newSkill(
  root: string,
  name: string,
  description: string,
): { ok: true; location: string } | { ok: false; reason: string } {
  const wrong = skillNameProblem(name);
  if (wrong) return { ok: false, reason: wrong };
  const text = description.trim();
  if (text === "") {
    return { ok: false, reason: "a skill needs a description: what it does, and when to use it" };
  }
  if (text.length > 1024) return { ok: false, reason: "a description has at most 1024 characters" };
  const dir = join(root, name);
  const location = join(dir, "SKILL.md");
  if (existsSync(location)) return { ok: false, reason: `${location} already exists` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    location,
    `---
name: ${name}
description: ${JSON.stringify(text)}
---

# ${name}

## When to use it

${text}

## How

1. Step by step, what to do.
2. What to check before saying it is done.

Files of this skill (scripts/, references/, assets/) are read with the \`skill\` tool.
`,
  );
  return { ok: true, location };
}

function listFiles(dir: string, base = dir, depth = 0): string[] {
  if (depth > 3) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    if (entry === ".git" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (isDir(path)) out.push(...listFiles(path, base, depth + 1));
    else out.push(relative(base, path).split(sep).join("/"));
  }
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
