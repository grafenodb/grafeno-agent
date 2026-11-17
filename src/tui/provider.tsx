import { Box, Text } from "ink";
import { useKeys } from "./core/input.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWheel } from "./mouse.js";
import { useListRows, windowStart } from "./picker.js";
import type { Provider, ProviderStatus } from "../providers/types.js";
import { AutoModelsPanel } from "./auto-models.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";
import { Clickable } from "./clicks.js";

export interface ProviderPanelProps {
  readonly providers: readonly Provider[];
  /** The panel's title (a section of /connect); default: Provider. */
  readonly title?: string;
  /** A line under the title: what the section is. */
  readonly subtitle?: string;
  /** The first run: Enter goes on even when the provider is not ready yet. */
  readonly firstRun?: boolean;
  /** The provider the chat uses now. */
  readonly current?: string;
  /** General Auto is on: offered as the first row, above every provider. */
  readonly auto?: boolean;
  /** Chosen General Auto; without it, the row is not offered (the first run). */
  readonly onAuto?: () => void;
  /** No model is selected now (the chat uses none). */
  readonly none?: boolean;
  /** Chosen no model at all: offered as a row under Auto; without it, not offered. */
  readonly onNone?: () => void;
  /** The providers General Auto includes; with `onToggleAuto`, space includes or leaves one out. */
  readonly autoMembers?: readonly string[];
  readonly onToggleAuto?: (id: string) => void;
  /** Providers reached with an API key (they may bill per token): said on their row. */
  readonly apiKeyProviders?: readonly string[];
  /** For each provider in Auto, the models chosen (none: Auto); with `onAutoModels`, m chooses them. */
  readonly autoModels?: Readonly<Record<string, readonly string[]>>;
  readonly onAutoModels?: (id: string, models: string[]) => void;
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
  // The row of what is in use: Auto (the first row) or the current provider.
  const [choosingModels, setChoosingModels] = useState<Provider | undefined>(undefined);
  // What each provider's status says (installed, signed in…) is folded until asked for.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // The first run shows them all: it is where the user sees what is installed and signed in.
  const [allOpen, setAllOpen] = useState(props.firstRun === true);
  const [selected, setSelected] = useState(() => {
    if (props.auto && props.onAuto) return 0;
    if (props.none && props.onNone) return props.onAuto ? 1 : 0;
    const index = props.providers.findIndex((p) => p.id === props.current);
    return index < 0 ? 0 : index + (props.onAuto ? 1 : 0) + (props.onNone ? 1 : 0);
  });

  const shown = useMemo(
    () => props.providers.filter((p) => matchesProvider(p, query)),
    [props.providers, query],
  );
  const offerAuto =
    props.onAuto !== undefined &&
    (query.trim() === "" || "auto".includes(query.trim().toLowerCase()));
  const offerNone =
    props.onNone !== undefined &&
    (query.trim() === "" ||
      // Space is Auto's key here, so what is typed has none: "nomodel" and "none" both match.
      ["nomodel", "none"].some((w) => w.includes(query.replace(/\s/g, "").toLowerCase())));
  // Auto is always the first row, then no model; the providers follow them.
  const noneRow = offerAuto ? 1 : 0;
  const first = (offerAuto ? 1 : 0) + (offerNone ? 1 : 0);
  const rows = shown.length + first;
  const at = Math.min(selected, Math.max(0, rows - 1));
  const onAuto = offerAuto && at === 0;
  const onNone = offerNone && at === noneRow;
  const onSpecial = onAuto || onNone;
  const isOpen = (id: string) => allOpen || opened.has(id);
  const autoEmpty = props.autoMembers !== undefined && props.autoMembers.length === 0;
  // A folded provider takes two lines, an open one about five: as many as fit (three at least).
  const visible = Math.max(
    3,
    Math.floor(useListRows(undefined, 80, offerAuto ? 18 : 14) / (allOpen ? 5 : 2)),
  );
  const providerAt = Math.max(0, at - first);
  const start = windowStart(providerAt, visible, shown.length);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, shown.length - start - visible);
  useWheel(
    useCallback(
      (direction: number) => {
        if (choosingModels) return;
        setSelected((s) => Math.max(0, Math.min(rows - 1, Math.min(s, rows - 1) - direction)));
      },
      [choosingModels, rows],
    ),
  );

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

  useKeys((input, key) => {
    if (choosingModels) return;
    if (key.escape) {
      if (query !== "") {
        setQuery("");
        setSelected(0);
      } else props.onDone(undefined);
    } else if (key.upArrow) setSelected(Math.max(0, at - 1));
    else if (key.downArrow) setSelected(Math.min(rows - 1, at + 1));
    else if (key.rightArrow || key.leftArrow) {
      const chosen = shown[at - first];
      if (chosen && !onSpecial) {
        setOpened((was) => {
          const next = new Set(was);
          if (key.rightArrow) next.add(chosen.id);
          else next.delete(chosen.id);
          return next;
        });
      }
    } else if (key.tab) setAllOpen((open) => !open);
    else if (key.pageUp) setSelected(Math.max(0, at - visible));
    else if (key.pageDown) setSelected(Math.min(rows - 1, at + visible));
    else if (key.ctrl && input === "r") {
      setStatuses(new Map());
      setChecking((c) => c + 1);
    } else if (
      (input === "m" || input === "M") &&
      query === "" &&
      props.onAutoModels &&
      !onSpecial &&
      shown[at - first] !== undefined
    ) {
      setChoosingModels(shown[at - first]);
    } else if (input === " " && props.onToggleAuto && !onSpecial) {
      const chosen = shown[at - first];
      if (chosen) props.onToggleAuto(chosen.id);
    } else if (key.return) {
      if (onAuto) props.onAuto();
      else if (onNone) props.onNone();
      else {
        const chosen = shown[at - first];
        if (chosen) props.onDone(statuses.get(chosen.id), chosen);
      }
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
    } else if (input && !key.ctrl && !key.meta && input !== " ") {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  if (choosingModels) {
    return (
      <AutoModelsPanel
        provider={choosingModels}
        chosen={props.autoModels?.[choosingModels.id] ?? []}
        onDone={(models) => {
          if (models !== undefined) props.onAutoModels?.(choosingModels.id, models);
          setChoosingModels(undefined);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>
          {props.title ?? "Provider"}
        </Text>
        <Text dimColor> · {String(props.providers.length)} known · search: </Text>
        <Text color={theme.accent}>{query === "" ? "type a name" : query}</Text>
      </Text>
      {offerAuto && (
        <Clickable flexDirection="column" marginTop={1} onClick={props.onAuto}>
          <Text {...(onAuto ? { color: theme.selected } : {})} bold={onAuto}>
            {onAuto ? "▸ " : "  "}
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
        </Clickable>
      )}
      {offerNone && (
        <Clickable flexDirection="column" marginTop={1} onClick={props.onNone}>
          <Text {...(onNone ? { color: theme.selected } : {})} bold={onNone}>
            {onNone ? "▸ " : "  "}
            No model{props.none ? " · in use" : ""}
          </Text>
          <Box paddingLeft={4}>
            <Text dimColor>
              The chat uses none: each message is refused until you choose one. The other
              connections stay on (switch one off in Manage connections).
            </Text>
          </Box>
        </Clickable>
      )}
      {shown.length === 0 && (
        <Text color={theme.warning}>No provider matches “{query}”. esc clears the search.</Text>
      )}
      {hiddenAbove > 0 && <Text dimColor> ↑ {String(hiddenAbove)} more</Text>}
      {shown.slice(start, start + visible).map((provider, offset) => {
        const index = start + offset;
        const status = statuses.get(provider.id);
        const on = index + first === at;
        return (
          <Box key={provider.id} flexDirection="column" marginTop={1}>
            <Box>
              <Clickable
                onClick={() => {
                  props.onDone(statuses.get(provider.id), provider);
                }}
              >
                <Text {...(on ? { color: theme.selected } : {})} bold={on}>
                  {on ? "▸ " : "  "}
                  {provider.name}
                  {provider.id === props.current ? " · in use" : ""}
                </Text>
                {status === undefined ? (
                  <Text dimColor> …</Text>
                ) : (
                  <Text> {<Mark ok={status.installed && status.signedIn} />}</Text>
                )}
              </Clickable>
              {props.autoMembers ? (
                <Clickable
                  {...(props.onToggleAuto
                    ? {
                        onClick: () => {
                          props.onToggleAuto?.(provider.id);
                        },
                      }
                    : {})}
                >
                  <Text
                    color={props.autoMembers.includes(provider.id) ? theme.success : theme.muted}
                  >
                    {props.autoMembers.includes(provider.id)
                      ? "  [✓ in Auto]"
                      : "  [  not in Auto]"}
                  </Text>
                </Clickable>
              ) : null}
              {props.autoMembers?.includes(provider.id) && props.onAutoModels ? (
                <Clickable
                  onClick={() => {
                    setChoosingModels(provider);
                  }}
                >
                  <Text dimColor>
                    {(props.autoModels?.[provider.id]?.length ?? 0) > 0
                      ? ` models: ${(props.autoModels?.[provider.id] ?? []).join(", ")}`
                      : " models: auto"}
                  </Text>
                </Clickable>
              ) : null}
            </Box>
            {props.apiKeyProviders?.includes(provider.id) && (
              <Box paddingLeft={4}>
                <Text dimColor>API key: may bill per token; in Auto only if you include it.</Text>
              </Box>
            )}
            {!isOpen(provider.id) ? null : status === undefined ? (
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
      {hiddenBelow > 0 && <Text dimColor> ↓ {String(hiddenBelow)} more (↑↓, wheel, PgDn)</Text>}
      <Box marginTop={1}>
        <Text dimColor>
          The chat uses the one chosen here; a run may give tasks to the ones in Auto.
        </Text>
      </Box>
      <Text dimColor>
        type to search · enter {props.firstRun ? "continue" : "use it"}
        {props.onToggleAuto ? " · space in Auto or not" : ""}
        {props.onAutoModels ? " · m its models" : ""} · ctrl+r check again · esc{" "}
        {props.firstRun ? "skip" : "back"}
      </Text>
      <Text dimColor>→ a provider's details (installed, signed in) · ← fold them · tab all</Text>
    </Box>
  );
}

function Mark({ ok }: { readonly ok: boolean }): ReactNode {
  return <Text color={ok ? theme.success : theme.error}>{ok ? "✓" : "✗"}</Text>;
}
