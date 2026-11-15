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
  /** General Auto is on: offered as the last row, after the providers. */
  readonly auto?: boolean;
  /** Chosen General Auto; without it, the row is not offered (the first run). */
  readonly onAuto?: () => void;
  /** The providers General Auto includes; with `onToggleAuto`, space includes or leaves one out. */
  readonly autoMembers?: readonly string[];
  readonly onToggleAuto?: (id: string) => void;
  /** Providers reached with an API key (they may bill per token): said on their row. */
  readonly apiKeyProviders?: readonly string[];
  /** With the status of the provider chosen (Enter), and the provider; nothing on Esc. */
  readonly onDone: (status: ProviderStatus | undefined, provider?: Provider) => void;
}

/** The providers the agent can reason with, and whether each is ready. */
export function ProviderPanel(props: ProviderPanelProps): ReactNode {
  const [statuses, setStatuses] = useState<(ProviderStatus | undefined)[]>([]);
  const [checking, setChecking] = useState(0);
  const [selected, setSelected] = useState(0);
  const rows = props.providers.length + (props.onAuto ? 1 : 0);

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
    else if (key.downArrow) setSelected((s) => Math.min(rows - 1, s + 1));
    else if (input === "r") {
      setStatuses([]);
      setChecking((c) => c + 1);
    } else if (input === " " && props.onToggleAuto && selected < props.providers.length) {
      const chosen = props.providers[selected];
      if (chosen) props.onToggleAuto(chosen.id);
    } else if (key.return) {
      if (selected === props.providers.length && props.onAuto) props.onAuto();
      else props.onDone(statuses[selected], props.providers[selected]);
    }
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
              {props.autoMembers ? (
                <Text color={props.autoMembers.includes(provider.id) ? theme.success : theme.muted}>
                  {props.autoMembers.includes(provider.id) ? "  [✓ in Auto]" : "  [  not in Auto]"}
                </Text>
              ) : null}
            </Text>
            {props.apiKeyProviders?.includes(provider.id) && (
              <Box paddingLeft={4}>
                <Text dimColor>API key: may bill per token; in Auto only if you include it.</Text>
              </Box>
            )}
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
      {props.onAuto && (
        <Box flexDirection="column" marginTop={1}>
          <Text
            {...(selected === props.providers.length ? { color: theme.accent } : {})}
            bold={selected === props.providers.length}
          >
            {selected === props.providers.length ? "▸ " : "  "}
            Auto{props.auto ? " · in use" : ""}
          </Text>
          <Box paddingLeft={4}>
            <Text dimColor>
              The ready providers marked in Auto
              {props.autoMembers && props.autoMembers.length > 0
                ? ` (${props.autoMembers.join(", ")})`
                : ""}
              : a light model triages each message, answered directly or planned across them.
            </Text>
          </Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          The chat uses the one chosen here; a run may give tasks to every ready one.
        </Text>
      </Box>
      <Text dimColor>
        enter {props.firstRun ? "continue" : "use it"}
        {props.onToggleAuto ? " · space in Auto or not" : ""} · r check again · esc{" "}
        {props.firstRun ? "skip" : "close"}
      </Text>
    </Box>
  );
}

function Mark({ ok }: { readonly ok: boolean }): ReactNode {
  return <Text color={ok ? theme.success : theme.error}>{ok ? "✓" : "✗"}</Text>;
}
