import { Box, Text } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { providerEnabled } from "../../providers/profiles.js";
import type { Provider, ProviderStatus } from "../../providers/types.js";
import { connectionState, connectionType, STATE_LOOK } from "../adapters/providers.js";
import { AutoModelsPanel } from "../auto-models.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";
import { Inspector, type Field } from "../ui/inspector.js";
import { Table, type Row } from "../ui/table.js";

/** Which switch Space flips on the row chosen: in Auto or not, switched on or off. */
type Switch = "auto" | "on";

const NO_MODEL_ROW = "\u0000none";
/** The rows of the window's own actions ("Add connection", "Manage") start so. */
const ACTION_ROW = "\u0000action:";

/** Whether a connection matches what was typed: its name or its id, in any case. */
export function matchesConnection(provider: Pick<Provider, "id" | "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || provider.name.toLowerCase().includes(q) || provider.id.includes(q);
}

/**
 * The connections, one window for /providers and each section of /connect:
 * typed letters search them by name, ↑↓ PgUp PgDn scroll, and each row has
 * two switches: **Auto** (whether General Auto may use it) and **On**
 * (switched off, nothing uses it, whatever is signed in). ←→ choose which
 * switch Space flips. Enter uses one for the chat (or asks for its key when
 * it has none yet), m chooses its models in Auto, ctrl+r asks them again.
 * Each one's state comes from what it answered, never a setting alone.
 */
export function ProvidersView(props: {
  readonly providers: readonly Provider[];
  readonly title?: string;
  /** The chat's provider now. */
  readonly current?: string;
  /** No model is selected now (offered as a row, when `onNone` is given). */
  readonly none?: boolean;
  readonly onNone?: () => void;
  /** The providers General Auto includes. */
  readonly autoMembers: readonly string[];
  readonly onToggleAuto: (id: string) => void;
  /** Switches a connection on or off; says what happened. */
  readonly onSwitch: (id: string, on: boolean) => string;
  readonly onUse: (provider: Provider, status: ProviderStatus) => void;
  /** A connection that needs a key it does not have yet: where it is typed. */
  readonly needsKey?: (provider: Provider, status: ProviderStatus) => boolean;
  readonly onKey?: (provider: Provider) => void;
  /** For each provider in Auto, the models chosen (none: all); m changes them. */
  readonly autoModels?: Readonly<Record<string, readonly string[]>>;
  readonly onAutoModels?: (id: string, models: string[]) => void;
  readonly notice?: (message: string) => void;
  /**
   * Only what is connected (or switched On) is listed; typing searches them
   * all. The window's first screen, as /connect and /providers open it.
   */
  readonly connectedOnly?: boolean;
  /** Rows of the window's own above the connections: "+ Add connection", "Manage". */
  readonly actions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
  }[];
  readonly onAction?: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProviderStatus>>(new Map());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const [asked, setAsked] = useState(0);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<Provider | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [switchOn, setSwitchOn] = useState<Switch>("auto");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // Switched on or off here: shown at once (the setting is read again on the next ask).
  const [, setFlips] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all(
      props.providers.map(async (p) => {
        try {
          return [p.id, await p.status(), undefined] as const;
        } catch (error) {
          return [p.id, undefined, error instanceof Error ? error.message : String(error)] as const;
        }
      }),
    ).then((found) => {
      if (!live) return;
      setStatuses(new Map(found.flatMap(([id, s]) => (s ? [[id, s] as const] : []))));
      setFailed(new Map(found.flatMap(([id, , f]) => (f ? [[id, f] as const] : []))));
    });
    return () => {
      live = false;
    };
  }, [props.providers, asked]);

  const shown = useMemo(
    () =>
      props.providers.filter((p) => {
        if (!matchesConnection(p, query)) return false;
        // The first screen: what is connected or On; a search finds the rest.
        if (props.connectedOnly !== true || query !== "" || providerEnabled(p.id)) return true;
        const status = statuses.get(p.id);
        return (
          status !== undefined && connectionState({ id: p.id, status }).state !== "unavailable"
        );
      }),
    [props.providers, props.connectedOnly, query, statuses],
  );
  const offerNone =
    props.onNone !== undefined &&
    ["nomodel", "none"].some((w) => w.includes(query.replace(/\s/g, "").toLowerCase()));
  const stateOf = (id: string) => {
    const status = statuses.get(id);
    const why = failed.get(id);
    return connectionState({
      id,
      ...(status ? { status } : {}),
      ...(why === undefined ? {} : { failed: why }),
    });
  };
  const toggle = (on: boolean) => (on ? "[ON ]" : "[OFF]");
  const rows: Row[] = [
    ...(query === ""
      ? (props.actions ?? []).map((a) => ({
          id: ACTION_ROW + a.id,
          cells: { name: a.label, type: "", state: "", auto: "", on: "", why: a.hint },
        }))
      : []),
    ...(offerNone
      ? [
          {
            id: NO_MODEL_ROW,
            cells: {
              name: `No model${props.none === true ? " · in use" : ""}`,
              type: "—",
              state: "the chat uses none",
              auto: "",
              on: "",
              why: "enter: nothing connected is sent anything from the chat",
            },
            tone: "muted" as const,
          },
        ]
      : []),
    ...shown.map((p) => {
      const asking = !statuses.has(p.id) && !failed.has(p.id);
      const { state, why } = stateOf(p.id);
      const look = STATE_LOOK[state];
      return {
        id: p.id,
        cells: {
          name: `${p.name}${p.id === props.current ? " · in use" : ""}`,
          type: connectionType(p.id),
          state: asking ? "… asking" : `${look.mark} ${state}`,
          auto: toggle(props.autoMembers.includes(p.id)),
          on: toggle(providerEnabled(p.id)),
          why: asking ? "" : why,
        },
        ...(asking ? {} : { tone: look.tone }),
      };
    }),
  ];
  const chosenId =
    selected !== undefined && rows.some((r) => r.id === selected) ? selected : rows[0]?.id;
  const chosen = shown.find((p) => p.id === chosenId);
  const hidden = props.providers.length - shown.length;

  const flip = () => {
    if (!chosen) return;
    if (switchOn === "auto") props.onToggleAuto(chosen.id);
    else {
      // Switched first, then said: an optional notice must not skip the switch.
      const said = props.onSwitch(chosen.id, !providerEnabled(chosen.id));
      props.notice?.(said);
      setFlips((n) => n + 1);
      setAsked((n) => n + 1);
    }
  };
  const enter = (id: string) => {
    if (id.startsWith(ACTION_ROW)) {
      props.onAction?.(id.slice(ACTION_ROW.length));
      return;
    }
    if (id === NO_MODEL_ROW) {
      props.onNone?.();
      return;
    }
    const provider = props.providers.find((p) => p.id === id);
    const status = statuses.get(id);
    if (provider && status && props.needsKey?.(provider, status) === true) {
      props.onKey?.(provider);
      return;
    }
    if (provider && status) props.onUse(provider, status);
    else if (provider) props.notice?.(`${provider.name} has not answered yet.`);
  };

  const busy = open !== undefined || models !== undefined;
  useKeys((input, key) => {
    if (busy) return;
    if (key.escape) {
      if (query !== "") setQuery("");
      else props.onClose();
    } else if (key.leftArrow || key.rightArrow) setSwitchOn((s) => (s === "auto" ? "on" : "auto"));
    else if (input === " ") flip();
    else if (key.ctrl && input === "r") {
      setStatuses(new Map());
      setAsked((n) => n + 1);
    } else if (input === "m" && query === "" && chosen && props.onAutoModels) setModels(chosen);
    else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.tab && !key.return && input !== " ") {
      setQuery((q) => q + input);
    }
  });

  if (models) {
    return (
      <AutoModelsPanel
        provider={models}
        chosen={props.autoModels?.[models.id] ?? []}
        onDone={(picked) => {
          if (picked !== undefined) props.onAutoModels?.(models.id, picked);
          setModels(undefined);
        }}
      />
    );
  }

  const inspected = open ? props.providers.find((p) => p.id === open) : undefined;
  const fields = (p: Provider): Field[] => {
    const status = statuses.get(p.id);
    const { state, why } = stateOf(p.id);
    return [
      { label: "Connection", value: p.name },
      { label: "Id", value: p.id },
      { label: "Type", value: connectionType(p.id) },
      { label: "State", value: `${STATE_LOOK[state].mark} ${state}`, tone: STATE_LOOK[state].tone },
      { label: "Why", value: why },
      { label: "Switched", value: providerEnabled(p.id) ? "on" : "off" },
      { label: "In Auto", value: props.autoMembers.includes(p.id) ? "yes" : "no" },
      { label: "Version", value: status?.version ?? "unknown" },
      { label: "Plan", value: status?.plan ?? "unknown" },
      { label: "Billing", value: status?.billing?.kind ?? "unknown" },
      { label: "In use", value: p.id === props.current ? "yes, by the chat" : "no" },
    ];
  };
  const head = (name: string, mine: Switch) => (switchOn === mine ? `▸${name}` : name);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <Text>
        <Text bold color={theme.focus}>
          {props.title ?? "Providers"}
        </Text>
        <Text dimColor>
          {" "}
          · {String(shown.length)}
          {query === "" ? "" : ` of ${String(props.providers.length)}`} · search:{" "}
        </Text>
        <Text color={theme.accent}>{query === "" ? "type a name" : query}</Text>
        {props.connectedOnly === true && query === "" && hidden > 0 && (
          <Text dimColor> · {String(hidden)} not connected (type to find them)</Text>
        )}
      </Text>
      {rows.length === 0 && (
        <Text color={theme.warning}>Nothing matches “{query}”: esc clears it.</Text>
      )}
      <Table
        columns={[
          { key: "name", title: "Connection", width: 28 },
          { key: "type", title: "Type", width: 8 },
          { key: "state", title: "State", width: 14 },
          { key: "auto", title: head("Auto", "auto"), width: 6 },
          { key: "on", title: head("On", "on"), width: 6 },
          { key: "why", title: "Detail", width: 40 },
        ]}
        rows={rows}
        height={12}
        isActive={!busy}
        onSelect={setSelected}
        onOpen={enter}
        onMenu={(id) => {
          if (id !== NO_MODEL_ROW && !id.startsWith(ACTION_ROW)) setOpen(id);
        }}
      />
      <Text dimColor wrap="truncate-end">
        type to search · ↑↓ PgUp PgDn · ←→ which switch · space flips it (
        {switchOn === "auto" ? "Auto" : "On"}) · enter use · shift+f10 details
        {props.onAutoModels ? " · m its models in Auto" : ""} · ctrl+r ask again · esc{" "}
        {query === "" ? "close" : "clear"}
      </Text>
      {inspected && (
        <Inspector
          title={`Connection · ${inspected.name}`}
          fields={fields(inspected)}
          actions={[
            { id: "use", label: "Use it for the chat" },
            props.autoMembers.includes(inspected.id)
              ? { id: "auto", label: "Leave Auto" }
              : { id: "auto", label: "Put in Auto" },
            providerEnabled(inspected.id)
              ? { id: "off", label: "Switch off" }
              : { id: "on", label: "Switch on" },
            { id: "ask", label: "Ask it again" },
          ]}
          onAction={(id) => {
            const status = statuses.get(inspected.id);
            if (id === "use" && status) {
              setOpen(undefined);
              props.onUse(inspected, status);
            } else if (id === "use") props.notice?.(`${inspected.name} has not answered yet.`);
            else if (id === "auto") props.onToggleAuto(inspected.id);
            else if (id === "on" || id === "off") {
              const said = props.onSwitch(inspected.id, id === "on");
              props.notice?.(said);
              setFlips((n) => n + 1);
              setAsked((n) => n + 1);
            } else {
              setStatuses(new Map());
              setAsked((n) => n + 1);
            }
          }}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </Box>
  );
}
