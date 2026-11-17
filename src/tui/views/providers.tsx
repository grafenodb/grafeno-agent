import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import { providerEnabled } from "../../providers/profiles.js";
import type { Provider, ProviderStatus } from "../../providers/types.js";
import { connectionState, connectionType, STATE_LOOK } from "../adapters/providers.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";
import { Inspector, type Field } from "../ui/inspector.js";
import { Table, type Row } from "../ui/table.js";

const COLUMNS = [
  { key: "name", title: "Connection", width: 28 },
  { key: "type", title: "Type" },
  { key: "state", title: "State", width: 14 },
  { key: "why", title: "Detail", width: 44 },
];

/**
 * Every connection and what it is now: available, connected (held back),
 * configured (not signed in), unavailable or in error, from what each
 * answered (a setting alone is never a connection). Enter inspects one:
 * use it for the chat, switch it on or off, or ask it again.
 */
export function ProvidersView(props: {
  readonly providers: readonly Provider[];
  /** The chat's provider now. */
  readonly current?: string;
  readonly onUse: (provider: Provider, status: ProviderStatus) => void;
  /** Switches a connection on or off; resolves to what to say. */
  readonly onSwitch?: (id: string, on: boolean) => string;
  readonly notice?: (message: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProviderStatus>>(new Map());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const [asked, setAsked] = useState(0);
  const [open, setOpen] = useState<string | undefined>(undefined);
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
  useKeys((input, key) => {
    if (open) return;
    if (key.escape) props.onClose();
    else if (key.ctrl && input === "r") {
      setStatuses(new Map());
      setAsked((n) => n + 1);
    }
  });
  const stateOf = (id: string) => {
    const status = statuses.get(id);
    const why = failed.get(id);
    return connectionState({
      id,
      ...(status ? { status } : {}),
      ...(why === undefined ? {} : { failed: why }),
    });
  };
  const rows: Row[] = props.providers.map((p) => {
    const asking = !statuses.has(p.id) && !failed.has(p.id);
    const { state, why } = stateOf(p.id);
    const look = STATE_LOOK[state];
    return {
      id: p.id,
      cells: {
        name: `${p.name}${p.id === props.current ? " · in use" : ""}`,
        type: connectionType(p.id),
        state: asking ? "… asking" : `${look.mark} ${state}`,
        why: asking ? "" : why,
      },
      ...(asking ? {} : { tone: look.tone }),
    };
  });
  const chosen = open ? props.providers.find((p) => p.id === open) : undefined;
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
      { label: "Version", value: status?.version ?? "unknown" },
      { label: "Plan", value: status?.plan ?? "unknown" },
      { label: "Billing", value: status?.billing?.kind ?? "unknown" },
      { label: "In use", value: p.id === props.current ? "yes, by the chat" : "no" },
    ];
  };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <Text>
        <Text bold color={theme.focus}>
          Providers
        </Text>
        <Text dimColor> · {String(props.providers.length)} connections</Text>
      </Text>
      <Table columns={COLUMNS} rows={rows} height={12} isActive={!open} onOpen={setOpen} />
      <Text dimColor>enter inspect · ctrl+r ask again · esc close</Text>
      {chosen && (
        <Inspector
          title={`Connection · ${chosen.name}`}
          fields={fields(chosen)}
          actions={[
            { id: "use", label: "Use it for the chat" },
            providerEnabled(chosen.id)
              ? { id: "off", label: "Switch off" }
              : { id: "on", label: "Switch on" },
            { id: "ask", label: "Ask it again" },
          ]}
          onAction={(id) => {
            const status = statuses.get(chosen.id);
            if (id === "use" && status) {
              setOpen(undefined);
              props.onUse(chosen, status);
            } else if (id === "use") props.notice?.(`${chosen.name} has not answered yet.`);
            else if ((id === "on" || id === "off") && props.onSwitch) {
              props.notice?.(props.onSwitch(chosen.id, id === "on"));
              setAsked((n) => n + 1);
            } else if (id === "ask") {
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
