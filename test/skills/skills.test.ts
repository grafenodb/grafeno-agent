import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/app/session.js";
import { skillsCommand } from "../../src/app/skills-command.js";
import type { Config } from "../../src/config.js";
import { FakeModel } from "../../src/model/index.js";
import {
  safeArgument,
  skillsArguments,
  skillsCommand as cliCommand,
} from "../../src/skills/cli.js";
import {
  findSkills,
  newSkill,
  parseSkill,
  skillCatalog,
  skillNameProblem,
  skillRoots,
  skillTool,
} from "../../src/skills/skills.js";
import { SessionStore } from "../../src/sessions/store.js";
import { FakeVault } from "../memory/fake-vault.js";

let dir: string;
let project: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ga-skills-"));
  project = join(dir, "project");
  home = join(dir, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function skill(root: string, folder: string, frontmatter: string, body = "Do it step by step.") {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("reading SKILL.md", () => {
  it("reads plain, quoted and block fields, with or without a byte-order mark", () => {
    expect(
      parseSkill('---\nname: pdf\ndescription: "Work with PDFs: fill forms"\n---\nBody').fields,
    ).toEqual({
      name: "pdf",
      description: "Work with PDFs: fill forms",
    });
    const folded = parseSkill(
      "---\nname: x\ndescription: >-\n  Line one\n  line two.\nmetadata:\n  author: me\n---\n# Hi",
    );
    expect(folded.fields.description).toBe("Line one line two.");
    expect(folded.body).toBe("# Hi");
    expect(parseSkill("---\ndescription: |\n  a\n  b\n---\n").fields.description).toBe("a\nb");
    expect(parseSkill(`${String.fromCharCode(0xfeff)}---\nname: y\n---\n`).fields.name).toBe("y");
    expect(parseSkill("no frontmatter").fields).toEqual({});
  });

  it("checks names as the format says", () => {
    expect(skillNameProblem("pdf-tools")).toBeUndefined();
    expect(skillNameProblem("PDF")).toMatch(/lowercase/);
    expect(skillNameProblem("-x")).toMatch(/hyphen/);
    expect(skillNameProblem("a--b")).toMatch(/hyphen/);
    expect(skillNameProblem("x".repeat(65))).toMatch(/64/);
  });
});

describe("finding skills", () => {
  it("reads the project's and the user's, the project's first, and says what is wrong", () => {
    const roots = skillRoots(project, home);
    skill(roots[0]?.path ?? "", "deploy", "name: deploy\ndescription: Deploy this project.");
    skill(roots[1]?.path ?? "", "deploy", "name: deploy\ndescription: My own deploy.");
    skill(roots[2]?.path ?? "", "notes", "name: notes\ndescription: Write meeting notes.");
    skill(roots[1]?.path ?? "", "empty", "name: empty");
    skill(
      roots[1]?.path ?? "",
      "other-folder",
      "name: renamed\ndescription: A name that is not its folder's.",
    );
    const { skills, problems } = findSkills(roots);
    expect(skills.map((s) => [s.name, s.scope])).toEqual([
      ["deploy", "project"],
      ["renamed", "user"],
      ["notes", "user"],
    ]);
    expect(problems.join("\n")).toMatch(/deploy.*hidden by/);
    expect(problems.join("\n")).toMatch(/empty.*no description/);
    expect(problems.join("\n")).toMatch(/not its folder's/);
    // Folders that are not there are no problem.
    expect(findSkills(skillRoots(join(dir, "nowhere"), join(dir, "nobody")))).toEqual({
      skills: [],
      problems: [],
    });
  });

  it("tells the model each skill's name, purpose and place, and how to use one", () => {
    skill(join(project, ".agents", "skills"), "pdf", "name: pdf\ndescription: Fill <forms> & more");
    const { skills } = findSkills(skillRoots(project, home));
    const catalog = skillCatalog(skills);
    expect(catalog).toContain("<available_skills>");
    expect(catalog).toContain("<name>pdf</name>");
    expect(catalog).toContain("Fill &lt;forms&gt; &amp; more");
    expect(catalog).toContain("call the `skill` tool");
    expect(skillCatalog([])).toBe("");
  });
});

describe("the skill tool", () => {
  it("loads a skill's instructions and its own files, never a file outside it", async () => {
    const root = join(project, ".agents", "skills");
    skill(root, "pdf", "name: pdf\ndescription: PDFs", "# PDF\nUse references/forms.md.");
    mkdirSync(join(root, "pdf", "references"));
    writeFileSync(join(root, "pdf", "references", "forms.md"), "Forms, in detail.");
    writeFileSync(join(project, "secret.txt"), "no");
    const tool = skillTool(() => findSkills(skillRoots(project, home)).skills);
    const signal = new AbortController().signal;
    expect(tool.writes).toBe(false);
    const loaded = await tool.run({ name: "pdf" }, { signal });
    expect(loaded).toContain("# Skill: pdf");
    expect(loaded).toContain("Use references/forms.md.");
    expect(loaded).toContain("Its files: references/forms.md");
    expect(loaded).not.toContain("description: PDFs");
    expect(await tool.run({ name: "pdf", file: "references/forms.md" }, { signal })).toBe(
      "Forms, in detail.",
    );
    expect(await tool.run({ name: "pdf", file: "../../../secret.txt" }, { signal })).toMatch(
      /outside/,
    );
    expect(await tool.run({ name: "nope" }, { signal })).toMatch(/No skill is named "nope".*pdf/);
  });
});

describe("skills of your own", () => {
  it("are made with a SKILL.md to fill in, only with a valid name and a description", () => {
    const root = join(project, ".agents", "skills");
    const made = newSkill(
      root,
      "release-notes",
      "Write release notes from the git log. Use when releasing.",
    );
    expect(made.ok).toBe(true);
    const text = readFileSync(join(root, "release-notes", "SKILL.md"), "utf8");
    expect(parseSkill(text).fields).toEqual({
      name: "release-notes",
      description: "Write release notes from the git log. Use when releasing.",
    });
    expect(newSkill(root, "release-notes", "again")).toMatchObject({ ok: false });
    expect(newSkill(root, "Bad Name", "x")).toMatchObject({ ok: false });
    expect(newSkill(root, "no-description", " ")).toMatchObject({ ok: false });
    expect(findSkills(skillRoots(project, home)).skills.map((s) => s.name)).toEqual([
      "release-notes",
    ]);
  });
});

describe("the skills command", () => {
  it("installs with the Skills CLI for its universal agent, and lists what the agent reads", async () => {
    const ran: { args: readonly string[]; cwd: string }[] = [];
    const said: string[] = [];
    const run = (args: readonly string[], cwd: string) => {
      ran.push({ args, cwd });
      skill(
        join(project, ".agents", "skills"),
        "frontend-design",
        "name: frontend-design\ndescription: Design UIs.",
      );
      return Promise.resolve(0);
    };
    const options = { cwd: project, home, run, say: (l: string) => said.push(l) };
    expect(
      await skillsCommand(
        ["add", "vercel-labs/agent-skills", "--skill", "frontend-design"],
        options,
      ),
    ).toBe(0);
    expect(ran[0]).toEqual({
      args: [
        "add",
        "vercel-labs/agent-skills",
        "-a",
        "universal",
        "-y",
        "--skill",
        "frontend-design",
      ],
      cwd: project,
    });
    expect(said.join("\n")).toContain("frontend-design");
    await skillsCommand(["add", "owner/repo", "-g"], options);
    expect(ran[1]?.args).toContain("-g");
    // Nothing that a shell could read differently.
    expect(await skillsCommand(["add", "owner/repo; rm -rf /"], options)).toBe(2);
    expect(ran).toHaveLength(2);
    // A failing install says so.
    const failing = { ...options, run: () => Promise.resolve(3) };
    expect(await skillsCommand(["add", "owner/repo"], failing)).toBe(3);
  });

  it("makes your own skill, and check fails when a skill has a problem", async () => {
    const said: string[] = [];
    const options = {
      cwd: project,
      home,
      run: () => Promise.resolve(0),
      say: (l: string) => said.push(l),
    };
    expect(
      await skillsCommand(
        ["new", "triage", "--description", "Sort bug reports. Use for new issues."],
        options,
      ),
    ).toBe(0);
    expect(
      await skillsCommand(["new", "home-one", "--description", "Mine everywhere.", "-g"], options),
    ).toBe(0);
    expect(findSkills(skillRoots(project, home)).skills.map((s) => [s.name, s.scope])).toEqual([
      ["triage", "project"],
      ["home-one", "user"],
    ]);
    expect(await skillsCommand(["check"], options)).toBe(0);
    skill(join(project, ".agents", "skills"), "broken", "name: broken");
    expect(await skillsCommand(["check"], options)).toBe(1);
  });

  it("runs the official CLI through npm's own npx, with no shell", () => {
    const command = cliCommand();
    expect(command.prefix).toContain("skills");
    expect(skillsArguments({ kind: "remove", name: "pdf" }, true)).toEqual([
      "remove",
      "pdf",
      "-a",
      "universal",
      "-y",
      "-g",
    ]);
    expect(safeArgument("https://github.com/owner/repo")).toBe(true);
    expect(safeArgument("a b")).toBe(false);
  });
});

describe("skills in a session", () => {
  const config: Config = {
    grafenoMode: "external",
    grafenoUrl: "http://grafeno.test:7810",
    agentKey: "gk_test_0123456789abcdef",
    namespace: "test",
    model: "fake",
    embedder: "none",
    palace: "shared",
  };

  it("reach the agent: their catalog in its instructions, and the tool that loads one", async () => {
    skill(
      join(project, ".agents", "skills"),
      "deploy",
      "name: deploy\ndescription: Deploy this project.",
      "Run the deploy script.",
    );
    const model = new FakeModel({
      turns: [
        [{ call: "skill", input: { name: "deploy" } }, { say: (c) => c.results[0]?.content ?? "" }],
      ],
    });
    const session = await AgentSession.start({
      config,
      vault: new FakeVault(),
      store: new SessionStore(join(dir, "sessions"), [config.agentKey]),
      cwd: project,
      makeModel: () => model,
      tools: () => [],
      skillRoots: skillRoots(project, home),
    });
    const turn = await session.send("deploy it");
    expect(model.conversations[0]?.system).toContain("<name>deploy</name>");
    expect(turn.result.text).toContain("Run the deploy script.");
    await session.close();
  });
});
