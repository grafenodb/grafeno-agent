import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import type { AppServices, LocalGrafeno } from "../app/services.js";
import { Connect } from "./connect.js";
import { Picker, type PickerItem } from "./picker.js";
import { theme } from "./theme.js";

export interface PalacePanelProps {
  readonly services: AppServices;
  /** The first run: there is no memory yet, and nothing to cancel back to. */
  readonly firstRun?: boolean;
  /** Called with what was done, or nothing when cancelled. */
  readonly onDone: (result: { message: string; changed: boolean } | undefined) => void;
}

type Step = "choose" | "installing" | "server";

/** Where the agent's memory lives: Grafeno included with the agent, or a server the user has. */
export function PalacePanel(props: PalacePanelProps): ReactNode {
  const { services } = props;
  const info = services.grafeno();
  const [step, setStep] = useState<Step>("choose");
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const [phase, setPhase] = useState("Downloading Grafeno");
  const [error, setError] = useState<string | undefined>(undefined);
  // A Grafeno already on this computer: offered by name, beside the agent's own.
  const [local, setLocal] = useState<LocalGrafeno | undefined | "looking">(
    services.findLocalGrafeno ? "looking" : undefined,
  );
  const [serverUrl, setServerUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void services.findLocalGrafeno?.().then((found) => {
      if (live) setLocal(found);
    });
    return () => {
      live = false;
    };
  }, [services]);
  const found = local === "looking" ? undefined : local;

  const include = () => {
    setStep("installing");
    setError(undefined);
    void services
      .includeGrafeno((done, total) => {
        setProgress({ done, total });
        if (done >= total) setPhase("Starting Grafeno");
      })
      .then((message) => {
        props.onDone({ message, changed: true });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStep("choose");
      });
  };

  const usingLocal =
    !props.firstRun && info.mode === "external" && info.hasKey && found?.url === info.url;
  const items: PickerItem[] = [
    {
      id: "include",
      label: "The agent's own Grafeno",
      hint: info.includable
        ? `${props.firstRun ? "recommended · " : ""}self-hosted by the agent on 127.0.0.1:7811, with its own data${found ? `: your Grafeno at ${found.url} stays untouched` : ""}`
        : "not available for this system",
      current: !props.firstRun && info.mode === "included",
    },
    ...(found
      ? [
          {
            id: "local",
            label: "The Grafeno on this computer",
            hint: `Grafeno ${found.version} at ${found.url} · the agent's memory goes in a namespace of its own there (a key from its administrator)`,
            current: usingLocal,
          },
        ]
      : []),
    {
      id: "server",
      label: found ? "Another Grafeno server" : "Connect to a Grafeno server",
      hint: found
        ? "a server elsewhere, at its address"
        : local === "looking"
          ? "looking for a Grafeno on this computer…"
          : "one you already run (none answers on this computer)",
      current: !props.firstRun && info.mode === "external" && info.hasKey && !usingLocal,
    },
    ...(info.mode === "included" && !props.firstRun
      ? [
          {
            id: "stop",
            label: "Stop the included Grafeno",
            hint: "it starts again with the next session",
          },
        ]
      : []),
  ];

  return (
    <Box flexDirection="column">
      {!props.firstRun && (
        <Box paddingX={1}>
          <Text dimColor>
            Now: {info.mode === "included" ? "Grafeno included" : "Grafeno server"} at {info.url} ·
            namespace {info.namespace}
          </Text>
        </Box>
      )}
      {error !== undefined && (
        <Box paddingX={1}>
          <Text color={theme.error}>✗ {error}</Text>
        </Box>
      )}
      {step === "choose" && (
        <Picker
          title={props.firstRun ? "Where should the agent keep its memory?" : "Memory (Grafeno)"}
          items={items}
          onCancel={() => {
            if (!props.firstRun) props.onDone(undefined);
          }}
          onSelect={(item) => {
            if (item.id === "include") {
              if (info.includable) include();
              else
                setError("Grafeno has no build to include for this system: connect to a server.");
            } else if (item.id === "local" && found) {
              setServerUrl(found.url);
              setStep("server");
            } else if (item.id === "server") {
              setServerUrl(undefined);
              setStep("server");
            } else props.onDone({ message: services.stopGrafeno(), changed: false });
          }}
        />
      )}
      {step === "installing" && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
          <Text bold color={theme.brand}>
            Include Grafeno
          </Text>
          <Text>{phase}…</Text>
          {progress !== undefined && <Bar done={progress.done} total={progress.total} />}
          <Text dimColor>The official build, checked against its published checksum.</Text>
        </Box>
      )}
      {step === "server" && (
        <Connect
          current={{
            url: serverUrl ?? (info.mode === "external" ? info.url : "http://127.0.0.1:7810"),
            namespace: info.namespace,
            hasKey: info.mode === "external" && info.hasKey,
          }}
          settingsPath={services.settingsPath}
          onDone={(values) => {
            if (!values) {
              setStep("choose");
              return;
            }
            setStep("installing");
            setPhase("Checking the server");
            setProgress(undefined);
            void services
              .connectGrafeno(values)
              .then((message) => {
                props.onDone({ message, changed: true });
              })
              .catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e));
                setStep("server");
              });
          }}
        />
      )}
    </Box>
  );
}

function Bar({ done, total }: { readonly done: number; readonly total: number }): ReactNode {
  const width = 30;
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(share * width);
  return (
    <Text>
      <Text color={theme.brand}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(width - filled)}</Text>
      <Text> {String(Math.round(share * 100))}%</Text>
      <Text dimColor>
        {" "}
        {(done / 1_048_576).toFixed(1)} / {(total / 1_048_576).toFixed(1)} MB
      </Text>
    </Text>
  );
}
