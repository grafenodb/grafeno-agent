import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionDecision, Tool } from "../agent/tools.js";
import type { Workspace } from "./workspace.js";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The permission of a path that is changed: `never` outside the project, on secrets or in .git. */
function changePermission(workspace: Workspace, path: string, reason: string): PermissionDecision {
  const checked = workspace.check(path);
  if ("refused" in checked) return { permission: "never", reason: checked.refused };
  if (checked.relative === ".")
    return { permission: "never", reason: "it is the project folder itself" };
  if (checked.relative.split("/").includes(".git")) {
    return { permission: "never", reason: "git's own files are not changed by hand" };
  }
  return { permission: "ask", reason };
}

/** The strictest of several decisions: never, then ask, then free. */
function strictest(...decisions: PermissionDecision[]): PermissionDecision {
  return (
    decisions.find((d) => d.permission === "never") ??
    decisions.find((d) => d.permission === "ask") ??
    decisions[0] ?? { permission: "free" }
  );
}

export function fileInfoTool(workspace: Workspace): Tool {
  return {
    name: "file_info",
    description:
      "Tells whether a path of the project exists, and what it is: a file (its size and when it changed) or a folder (how many entries it has).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative to the project folder." } },
      required: ["path"],
      additionalProperties: false,
    },
    writes: false,
    permission: (input) => {
      const checked = workspace.check(str(input.path));
      return "refused" in checked
        ? { permission: "never", reason: checked.refused }
        : { permission: "free" };
    },
    run: async (input) => {
      const { absolute, relative } = await workspace.resolve(str(input.path));
      let info;
      try {
        info = await stat(absolute);
      } catch {
        return `${relative} does not exist.`;
      }
      const changed = info.mtime.toISOString();
      if (info.isDirectory()) {
        const entries = await readdir(absolute);
        return `${relative} is a folder with ${String(entries.length)} entries; changed ${changed}.`;
      }
      return `${relative} is a file of ${String(info.size)} bytes; changed ${changed}.`;
    },
  };
}

export function deleteFileTool(workspace: Workspace): Tool {
  return {
    name: "delete_file",
    description:
      "Deletes one file of the project, or an empty folder. The user is asked first. Folders with anything in them are never deleted by this tool.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative to the project folder." } },
      required: ["path"],
      additionalProperties: false,
    },
    writes: true,
    permission: (input) => changePermission(workspace, str(input.path), "it deletes a file"),
    describe: (input) => `delete ${str(input.path)}`,
    run: async (input) => {
      const { absolute, relative } = await workspace.resolve(str(input.path));
      const info = await stat(absolute);
      if (info.isDirectory()) {
        if ((await readdir(absolute)).length > 0) {
          throw new Error(`${relative} is a folder with files in it: it is not deleted`);
        }
        await rmdir(absolute);
        return `Deleted the empty folder ${relative}.`;
      }
      await unlink(absolute);
      return `Deleted ${relative}.`;
    },
  };
}

export function moveFileTool(workspace: Workspace): Tool {
  return {
    name: "move_file",
    description:
      "Moves or renames a file or folder of the project, making the destination's folders. It never replaces something that exists. The user is asked first.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "What to move, relative to the project folder." },
        to: { type: "string", description: "Its new path, relative to the project folder." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    writes: true,
    permission: (input) =>
      strictest(
        changePermission(workspace, str(input.from), "it moves a file"),
        changePermission(workspace, str(input.to), "it moves a file"),
      ),
    describe: (input) => `move ${str(input.from)} → ${str(input.to)}`,
    run: async (input) => {
      const from = await workspace.resolve(str(input.from));
      const to = await workspace.resolve(str(input.to));
      await stat(from.absolute);
      const exists = await stat(to.absolute).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error(`${to.relative} already exists: nothing was moved`);
      await mkdir(dirname(to.absolute), { recursive: true });
      await rename(from.absolute, to.absolute);
      return `Moved ${from.relative} to ${to.relative}.`;
    },
  };
}

interface Edit {
  readonly old_text: string;
  readonly new_text: string;
  readonly replace_all?: boolean;
}

export function multiEditTool(workspace: Workspace): Tool {
  return {
    name: "multi_edit",
    description:
      "Makes several changes to one file of the project in one step: each edit replaces old_text (exactly once, or every time with replace_all) by new_text, in order, on the result of the one before. Either every edit applies or none does. The user is asked first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to the project folder." },
        edits: {
          type: "array",
          description: "The changes, in order.",
          items: {
            type: "object",
            properties: {
              old_text: { type: "string" },
              new_text: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    writes: true,
    permission: (input) => changePermission(workspace, str(input.path), "it changes a file"),
    describe: (input) => {
      const edits = Array.isArray(input.edits) ? (input.edits as Edit[]) : [];
      const lines = edits.map(
        (edit, i) =>
          `    ${String(i + 1)}. ${JSON.stringify(edit.old_text).slice(0, 70)} → ${JSON.stringify(edit.new_text).slice(0, 70)}`,
      );
      return `edit ${str(input.path)} (${String(edits.length)} changes):\n${lines.join("\n")}`;
    },
    run: async (input) => {
      const { absolute, relative } = await workspace.resolve(str(input.path));
      const edits = (input.edits ?? []) as Edit[];
      if (edits.length === 0) throw new Error("no edits were given");
      let text = await readFile(absolute, "utf8");
      let replacements = 0;
      for (const [index, edit] of edits.entries()) {
        const n = String(index + 1);
        if (edit.old_text === "") throw new Error(`edit ${n}: old_text is empty`);
        const times = text.split(edit.old_text).length - 1;
        if (times === 0) throw new Error(`edit ${n}: old_text was not found; nothing was changed`);
        if (times > 1 && edit.replace_all !== true) {
          throw new Error(
            `edit ${n}: old_text appears ${String(times)} times; give more text around it, or replace_all. Nothing was changed`,
          );
        }
        text = text.split(edit.old_text).join(edit.new_text);
        replacements += times;
      }
      await writeFile(absolute, text, "utf8");
      return `Edited ${relative}: ${String(edits.length)} edits, ${String(replacements)} replacements.`;
    },
  };
}

/** The tools that look after files beyond reading and writing them. */
export function manageTools(workspace: Workspace): Tool[] {
  return [
    fileInfoTool(workspace),
    multiEditTool(workspace),
    moveFileTool(workspace),
    deleteFileTool(workspace),
  ];
}
