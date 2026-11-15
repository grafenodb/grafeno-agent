import { Box, Text, useInput } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import type { Provider, ProviderStatus } from "../providers/types.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export interface ProviderPanelProps {
  readonly providers: readonly Provider[];
  /** The first run: Enter goes on even when the provider is not ready yet. */
  readonly firstRun?: boolean;
  /** The provider the chat uses now. */
  readonly current?: string;
  /** With the status of the provider chosen (Enter), and the provider; nothing on Esc. */
  readonly onDone: (status: ProviderStatus | undefined, provider?: Provider) => void;
}

/** The providers the agent can reason with, and whether each is ready. */
export function ProviderPanel(props: ProviderPanelProps): ReactNode {
  const [statuses, setStatuses] = useState<(ProviderStatus | undefined)[]>([]);
  const [checking, setChecking] = useState(0);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all(props.providers.map((p) => p.status())).then((found) => {
      if (live) setStatuses(found);
    });
    return () => {
      live = false;
    };
  }, [props.providers, checking]);

  useInput((input, key) => {
    if (key.escape) props.onDone(undefined);
    else if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSelected((s) => Math.min(props.providers.length - 1, s + 1));
    else if (input === "r") {
      setStatuses([]);
      setChecking((c) => c + 1);
    } else if (key.return) props.onDone(statuses[selected], props.providers[selected]);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>
        Provider
      </Text>
      {props.providers.map((provider, index) => {
        const status = statuses[index];
        const on = index === selected;
        return (
          <Box key={provider.id} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <Text {...(on ? { color: theme.accent } : {})} bold={on}>
              {on ? "▸ " : "  "}
              {provider.name}
              {provider.id === props.current ? " · in use" : ""}
            </Text>
            {status === undefined ? (
              <Box paddingLeft={4}>
                <Spinner />
                <Text dimColor> checking…</Text>
              </Box>
            ) : (
              <Box flexDirection="column" paddingLeft={4}>
                <Text>
                  <Mark ok={status.installed} />{" "}
                  {status.installed
                    ? `Installed${status.version ? ` (${status.version})` : ""}`
                    : "Not installed"}
                </Text>
                <Text>
                  <Mark ok={status.signedIn} />{" "}
                  {status.signedIn
                    ? `Signed in${status.plan ? ` · ${status.plan}` : ""}`
                    : "Not signed in"}
                </Text>
                <Text dimColor>{status.detail}</Text>
                {!status.signedIn && status.installed && (
                  <Text color={theme.warning}>{provider.signIn}</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          The chat uses the one chosen here; a run may give tasks to every ready one.
        </Text>
      </Box>
      <Text dimColor>
        enter {props.firstRun ? "continue" : "use it"} · r check again · esc{" "}
        {props.firstRun ? "skip" : "close"}
      </Text>
    </Box>
  );
}

function Mark({ ok }: { readonly ok: boolean }): ReactNode {
  return <Text color={ok ? theme.success : theme.error}>{ok ? "✓" : "✗"}</Text>;
}
