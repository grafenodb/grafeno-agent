import { Box, Text } from "ink";
import { useKeys } from "./core/input.js";
import { useState, type ReactNode } from "react";
import { Prompt } from "./prompt.js";
import { theme } from "./theme.js";

/** What `/connect` asks for. */
export interface ConnectionValues {
  readonly url: string;
  /** A new key; absent to keep the one in the settings. */
  readonly key?: string;
  readonly namespace: string;
}

export interface ConnectProps {
  readonly current: { readonly url: string; readonly namespace: string; readonly hasKey: boolean };
  readonly settingsPath: string;
  readonly onDone: (values: ConnectionValues | undefined) => void;
}

type Step = "url" | "key" | "namespace";

/** The steps of `/connect`: Grafeno's address, the agent's key and its namespace. */
export function Connect(props: ConnectProps): ReactNode {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState(props.current.url);
  const [key, setKey] = useState<string | undefined>(undefined);

  useKeys((_input, k) => {
    if (k.escape) props.onDone(undefined);
  });

  const label: Record<Step, string> = {
    url: "Grafeno server address",
    key: props.current.hasKey
      ? "The agent's key (Enter keeps the one you have)"
      : "The agent's key (an administrator makes it: grafeno keys create)",
    namespace: "Namespace for the agent's memory",
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>
        Connect
      </Text>
      <Text dimColor>Saved in {props.settingsPath}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Done label="Server" value={step === "url" ? undefined : url} />
        {step !== "url" && step !== "key" && (
          <Done label="Key" value={key === undefined ? "unchanged" : "new (hidden)"} />
        )}
      </Box>
      <Text color={theme.accent}>{label[step]}</Text>
      {step === "url" && (
        <Prompt
          key="url"
          active
          commands={false}
          initial={props.current.url}
          onSubmit={(text) => {
            setUrl(text.trim() === "" ? props.current.url : text.trim());
            setStep("key");
          }}
        />
      )}
      {step === "key" && (
        <Prompt
          key="key"
          active
          commands={false}
          mask
          placeholder={props.current.hasKey ? "(keep the current key)" : "paste the key"}
          onSubmit={(text) => {
            setKey(text.trim() === "" ? undefined : text.trim());
            setStep("namespace");
          }}
        />
      )}
      {step === "namespace" && (
        <Prompt
          key="namespace"
          active
          commands={false}
          initial={props.current.namespace}
          onSubmit={(text) => {
            props.onDone({
              url,
              namespace: text.trim() === "" ? props.current.namespace : text.trim(),
              ...(key === undefined ? {} : { key }),
            });
          }}
        />
      )}
      <Text dimColor>enter next · esc cancel</Text>
    </Box>
  );
}

function Done({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | undefined;
}): ReactNode {
  if (value === undefined) return null;
  return (
    <Text>
      <Text color={theme.success}>✓ </Text>
      <Text dimColor>{label}: </Text>
      {value}
    </Text>
  );
}
