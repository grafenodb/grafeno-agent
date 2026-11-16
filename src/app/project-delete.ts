import { Grafeno, GrafenoError } from "@grafenodb/client";
import { loadConfig } from "../config.js";
import { dataDir } from "../data-dir.js";
import { deleteProject, type ProjectDeletion } from "../projects.js";
import { sessionsDir } from "../sessions/store.js";
import { prepareGrafeno } from "./services.js";

/**
 * Drops a namespace; resolves to whether it was there. A missing namespace
 * is not an error: a project whose sessions never started has none yet.
 */
export function namespaceDropper(client: Pick<Grafeno, "dropNamespace">) {
  return async (namespace: string): Promise<boolean> => {
    try {
      await client.dropNamespace(namespace);
      return true;
    } catch (error) {
      if (error instanceof GrafenoError && error.status === 404) return false;
      throw error;
    }
  };
}

/**
 * Deletes a project for good with the person's settings: its namespace in
 * their Grafeno (with the owner's token for the included one, else the
 * agent's key), its conversations and its runs. Its folder stays.
 */
export async function deleteProjectEverywhere(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectDeletion> {
  const config = await prepareGrafeno(loadConfig(env), env);
  const token =
    config.grafenoMode === "included"
      ? (env.GRAFENO_OWNER_TOKEN?.trim() ?? config.agentKey)
      : config.agentKey;
  const client = new Grafeno({ url: config.grafenoUrl, token });
  return deleteProject(name, {
    dropNamespace: namespaceDropper(client),
    sessionsDir: sessionsDir(env),
    dataDir: dataDir(env),
  });
}

/** What a deletion did, in a line for the person. */
export function describeDeletion(result: ProjectDeletion): string {
  const { project, namespace } = result;
  if (typeof namespace === "object") {
    return `${project.name} was not deleted: its namespace "${project.namespace}" could not be dropped (${namespace.failed}). Nothing else was touched; try again once Grafeno allows it.`;
  }
  const parts = [
    namespace === "dropped"
      ? `namespace "${project.namespace}" dropped`
      : "it had no namespace yet",
    `${String(result.sessions)} conversation${result.sessions === 1 ? "" : "s"}`,
    result.runs ? "its runs" : "no runs",
  ];
  return `Deleted ${project.name}: ${parts.join(", ")}. Its folder ${project.path} is as it was.`;
}
