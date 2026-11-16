import { Box, Text } from "ink";
import { basename, dirname, join } from "node:path";
import { useState, type ReactNode } from "react";
import { addProject, loadProjects, projectNameProblem, type ProjectEntry } from "../projects.js";
import { Picker } from "./picker.js";
import { Prompt } from "./prompt.js";
import { theme } from "./theme.js";

export interface ProjectsPanelProps {
  /** The folder the session works in now. */
  readonly current: string;
  /** Called with the project to open, or nothing when the panel is left. */
  readonly onDone: (project: ProjectEntry | undefined, message?: string) => void;
  /** Where the list is kept; for tests. */
  readonly file?: string;
}

type Step = "list" | "name" | "folder";

/**
 * The person's projects: open one (a new session in its folder), add the
 * folder the session is in, or make a new one (a folder with a git
 * repository). Sessions, runs and memory belong to the project they are in.
 */
export function ProjectsPanel(props: ProjectsPanelProps): ReactNode {
  const [step, setStep] = useState<Step>("list");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const projects = loadProjects(props.file);
  const here = projects.find((p) => p.path.toLowerCase() === props.current.toLowerCase());
  const add = (folder: string, chosen: string | undefined, create: boolean) => {
    try {
      const entry = addProject(folder, chosen, {
        create,
        ...(props.file ? { file: props.file } : {}),
      });
      props.onDone(entry, `Project ${entry.name} is ready at ${entry.path}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("list");
    }
  };

  return (
    <Box flexDirection="column">
      {error !== undefined && <Text color={theme.error}>✗ {error}</Text>}
      {step === "list" && (
        <Picker
          title={`Projects · now ${here?.name ?? basename(props.current)}`}
          items={[
            {
              id: "+new",
              label: "+ New project",
              hint: "a new folder, with git, and a session in it",
            },
            ...(here
              ? []
              : [
                  {
                    id: "+here",
                    label: "+ Add this folder",
                    hint: props.current,
                  },
                ]),
            ...projects.map((p) => ({
              id: p.path,
              label: p.name,
              hint: p.path,
              current: p === here,
            })),
          ]}
          onCancel={() => {
            props.onDone(undefined);
          }}
          onSelect={(item) => {
            setError(undefined);
            if (item.id === "+new") setStep("name");
            else if (item.id === "+here") add(props.current, undefined, false);
            else {
              const chosen = projects.find((p) => p.path === item.id);
              if (chosen) props.onDone(chosen);
            }
          }}
        />
      )}
      {step === "name" && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
          <Text bold color={theme.brand}>
            New project · its name
          </Text>
          <Prompt
            active
            commands={false}
            placeholder="such as shop-api"
            onSubmit={(text) => {
              const chosen = text.trim();
              const why = projectNameProblem(chosen);
              if (why) {
                setError(why);
                return;
              }
              setError(undefined);
              setName(chosen);
              setStep("folder");
            }}
          />
          <Text dimColor>enter next · esc back</Text>
        </Box>
      )}
      {step === "folder" && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
          <Text bold color={theme.brand}>
            New project {name} · its folder
          </Text>
          <Prompt
            active
            commands={false}
            initial={join(dirname(props.current), name)}
            onSubmit={(text) => {
              add(
                text.trim() === "" ? join(dirname(props.current), name) : text.trim(),
                name,
                true,
              );
            }}
          />
          <Text dimColor>Made when it does not exist, with a git repository · enter create</Text>
        </Box>
      )}
    </Box>
  );
}
