import { currentTimeTool } from "../agent/builtin-tools.js";
import type { Tool } from "../agent/tools.js";
import { defaultShell, runCommandTool } from "./command.js";
import { fileTools } from "./files.js";
import { manageTools } from "./manage.js";
import { ProcessManager, processTools } from "./processes.js";
import { environmentInfoTool } from "./system.js";
import { localHttpTool, webFetchTool } from "./web.js";
import type { Workspace } from "./workspace.js";

export interface ProjectToolsOptions {
  /** The shell for commands. Default: `defaultShell()`. */
  readonly shell?: readonly [string, ...string[]];
  /** Environment variables commands must not see. */
  readonly hiddenEnv?: readonly string[];
  /** Offer web_fetch. Default: true. */
  readonly web?: boolean;
  /** Offer background processes (start_process and the rest). Default: true. */
  readonly background?: boolean;
}

/**
 * The agent's own tools for a project: time, the environment, files,
 * commands (and background ones), local servers and the web.
 */
export function projectTools(workspace: Workspace, options: ProjectToolsOptions = {}): Tool[] {
  const shell = options.shell ?? defaultShell();
  const hiddenEnv = options.hiddenEnv ? { hiddenEnv: options.hiddenEnv } : {};
  return [
    currentTimeTool(),
    environmentInfoTool(workspace, { shell }),
    ...fileTools(workspace),
    ...manageTools(workspace),
    runCommandTool(workspace, { shell, ...hiddenEnv }),
    ...(options.background === false
      ? []
      : processTools(new ProcessManager(workspace, { shell, ...hiddenEnv }), workspace)),
    localHttpTool(),
    ...(options.web === false ? [] : [webFetchTool()]),
  ];
}

/** What the system prompt says about the tools. */
export function toolsPrompt(workspace: Workspace): string {
  return `## Your tools

Your file and command tools work in the project folder ${workspace.root}; paths are relative to it. (The folder the model program itself runs in is a private temporary one: ignore it.) Files of secrets (.env, keys, credentials) are never read or written. Writing, editing, moving or deleting a file, running a command that changes anything, starting a background process and fetching a web page all ask the user first; say briefly why before you do them. environment_info says what is installed; start_process runs a dev server or a watcher in the background, and local_http checks what it answers.`;
}
