import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../../src/memory/project.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the project of a folder", () => {
  it("is the git repository it is in, named after its folder unless a name is given", () => {
    dir = mkdtempSync(join(tmpdir(), "project-"));
    const repo = join(dir, "orch-test");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"));
    expect(detectProject(join(repo, "src"))).toEqual({ name: "orch-test", path: repo });
    expect(detectProject(repo, "named")).toEqual({ name: "named", path: repo });
  });

  it("an empty name (AGENT_PROJECT= in the settings) names nothing: the folder says", () => {
    dir = mkdtempSync(join(tmpdir(), "project-"));
    const repo = join(dir, "orch-test");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(detectProject(repo, "")).toEqual({ name: "orch-test", path: repo });
    expect(detectProject(repo, "  ")).toEqual({ name: "orch-test", path: repo });
  });
});
