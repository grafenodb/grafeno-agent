import { currentTimeTool } from "../agent/builtin-tools.js";
import type { Tool } from "../agent/tools.js";
import { defaultShell, runCommandTool } from "./command.js";
import { fileTools } from "./files.js";
import { webFetchTool } from "./web.js";
import type { Workspace } from "./workspace.js";

export interface ProjectToolsOptions {
  /** The shell for commands. Default: `defaultShell()`. */
  readonly shell?: readonly [string, ...string[]];
  /** Environment variables commands must not see. */
  readonly hiddenEnv?: readonly string[];
  /** Offer web_fetch. Default: true. */
  readonly web?: boolean;
}

/** The agent's own tools for a project: time, files, commands and the web. */
export function projectTools(workspace: Workspace, options: ProjectToolsOptions = {}): Tool[] {
  return [
    currentTimeTool(),
    ...fileTools(workspace),
    runCommandTool(workspace, {
      shell: options.shell ?? defaultShell(),
      ...(options.hiddenEnv ? { hiddenEnv: options.hiddenEnv } : {}),
    }),
    ...(options.web === false ? [] : [webFetchTool()]),
  ];
}

/** What the system prompt says about the tools. */
export function toolsPrompt(workspace: Workspace): string {
  return `## Your tools

Your file and command tools work in the project folder ${workspace.root}; paths are relative to it. (The folder the model program itself runs in is a private temporary one: ignore it.) Files of secrets (.env, keys, credentials) are never read or written. Writing a file, editing one, running a command that changes anything and fetching a web page all ask the user first; say briefly why before you do them.`;
}
