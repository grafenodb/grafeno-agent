import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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

/** Whether a provider matches what was typed: its name or its id, in any case. */
export function matchesProvider(provider: Pick<Provider, "id" | "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || provider.name.toLowerCase().includes(q) || provider.id.includes(q);
}

/**
 * The providers the agent can reason with, and whether each is ready.
 * Typing searches them by name (there will be many); ↑ ↓ choose, Enter
 * uses one, space includes it in Auto or leaves it out.
 */
export function ProviderPanel(props: ProviderPanelProps): ReactNode {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProviderStatus>>(new Map());
  const [checking, setChecking] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const shown = useMemo(
    () => props.providers.filter((p) => matchesProvider(p, query)),
    [props.providers, query],
  );
  const offerAuto =
    props.onAuto !== undefined &&
    (query.trim() === "" || "auto".includes(query.trim().toLowerCase()));
  const rows = shown.length + (offerAuto ? 1 : 0);
  const at = Math.min(selected, Math.max(0, rows - 1));
  const autoEmpty = props.autoMembers !== undefined && props.autoMembers.length === 0;

  useEffect(() => {
    let live = true;
    void Promise.all(props.providers.map(async (p) => [p.id, await p.status()] as const)).then(
      (found) => {
        if (live) setStatuses(new Map(found));
      },
    );
    return () => {
      live = false;
    };
  }, [props.providers, checking]);

  useInput((input, key) => {
    if (key.escape) {
      if (query !== "") {
        setQuery("");
        setSelected(0);
      } else props.onDone(undefined);
    } else if (key.upArrow) setSelected(Math.max(0, at - 1));
    else if (key.downArrow) setSelected(Math.min(rows - 1, at + 1));
    else if (key.ctrl && input === "r") {
      setStatuses(new Map());
      setChecking((c) => c + 1);
    } else if (input === " " && props.onToggleAuto && at < shown.length) {
      const chosen = shown[at];
      if (chosen) props.onToggleAuto(chosen.id);
    } else if (key.return) {
      if (at === shown.length && props.onAuto && offerAuto) props.onAuto();
      else {
        const chosen = shown[at];
        if (chosen) props.onDone(statuses.get(chosen.id), chosen);
      }
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
    } else if (input && !key.ctrl && !key.meta && input !== " " && !key.tab) {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>
          Provider
        </Text>
        <Text dimColor> · {String(props.providers.length)} known · search: </Text>
        <Text color={theme.accent}>{query === "" ? "type a name" : query}</Text>
      </Text>
      {shown.length === 0 && (
        <Text color={theme.warning}>No provider matches “{query}”. esc clears the search.</Text>
      )}
      {shown.map((provider, index) => {
        const status = statuses.get(provider.id);
        const on = index === at;
        return (
          <Box key={provider.id} flexDirection="column" marginTop={1}>
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
      {offerAuto && (
        <Box flexDirection="column" marginTop={1}>
          <Text
            {...(at === shown.length ? { color: theme.accent } : {})}
            bold={at === shown.length}
          >
            {at === shown.length ? "▸ " : "  "}
            Auto{props.auto ? " · in use" : ""}
          </Text>
          <Box paddingLeft={4}>
            {autoEmpty ? (
              <Text color={theme.warning}>
                No provider is in Auto yet: mark one with space before using Auto.
              </Text>
            ) : (
              <Text dimColor>
                The ready providers marked in Auto
                {props.autoMembers ? ` (${props.autoMembers.join(", ")})` : ""}: a light model
                triages each message, answered directly or planned across them.
              </Text>
            )}
          </Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          The chat uses the one chosen here; a run may give tasks to the ones in Auto.
        </Text>
      </Box>
      <Text dimColor>
        type to search · enter {props.firstRun ? "continue" : "use it"}
        {props.onToggleAuto ? " · space in Auto or not" : ""} · ctrl+r check again · esc{" "}
        {props.firstRun ? "skip" : "close"}
      </Text>
    </Box>
  );
}

function Mark({ ok }: { readonly ok: boolean }): ReactNode {
  return <Text color={ok ? theme.success : theme.error}>{ok ? "✓" : "✗"}</Text>;
}
