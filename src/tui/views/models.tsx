import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import { localState } from "../../providers/index.js";
import type { LocalModel } from "../../providers/local/discover.js";
import type { ModelOption, Provider } from "../../providers/types.js";
import { useKeys } from "../core/input.js";
import { theme } from "../theme.js";
import { Inspector, type Field } from "../ui/inspector.js";
import { Table, type Row } from "../ui/table.js";

const COLUMNS = [
  { key: "name", title: "Model", width: 30 },
  { key: "tier", title: "Tier" },
  { key: "context", title: "Context", align: "right" as const },
  { key: "tools", title: "Tools" },
  { key: "vision", title: "Vision" },
];

const yesNo = (value: boolean | undefined) =>
  value === undefined ? "unknown" : value ? "yes" : "no";

const tokens = (n: number | undefined) =>
  n === undefined ? "unknown" : n >= 1000 ? `${String(Math.round(n / 1000))}k` : String(n);

/** The tier a provider gives a model (its own catalog), when it gives one. */
function tierOf(provider: Provider, id: string): string {
  for (const tier of ["deep", "standard", "light"] as const) {
    if (provider.tiers?.[tier].includes(id) === true) return tier;
  }
  return "unknown";
}

/**
 * The chat's provider's models: each with what is verified of it (a model
 * server says its context and whether it takes tools or images; other
 * providers do not, and that is said: "unknown"). Enter inspects one, and
 * makes it the chat's model from there.
 */
export function ModelsView(props: {
  readonly provider: Provider;
  /** The model the chat asked for ("default": the provider's own). */
  readonly current: string;
  readonly onUse: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [models, setModels] = useState<readonly ModelOption[] | undefined>(undefined);
  const [local, setLocal] = useState<ReadonlyMap<string, LocalModel>>(new Map());
  const [open, setOpen] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void props.provider
      .models()
      .catch(() => [])
      .then((found) => {
        if (live) setModels(found);
      });
    const state = localState(props.provider.id);
    if (state) {
      void state
        .discovery()
        .then((found) => {
          if (live) setLocal(new Map(found.models.map((m) => [m.id, m])));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [props.provider]);
  useKeys((_input, key) => {
    if (!open && key.escape) props.onClose();
  });
  const rows: Row[] = (models ?? []).map((m) => {
    const known = local.get(m.id);
    return {
      id: m.id,
      cells: {
        name: `${m.name}${m.id === props.current ? " · in use" : ""}`,
        tier: tierOf(props.provider, m.id),
        context: tokens(known?.contextLength),
        tools: yesNo(known?.tools),
        vision: yesNo(known?.vision),
      },
    };
  });
  const chosen = open ? models?.find((m) => m.id === open) : undefined;
  const fields = (m: ModelOption): Field[] => {
    const known = local.get(m.id);
    return [
      { label: "Model", value: m.name },
      { label: "Id", value: m.id },
      { label: "Provider", value: props.provider.name },
      { label: "Tier", value: tierOf(props.provider, m.id) },
      { label: "Context", value: tokens(known?.contextLength) },
      { label: "Tools", value: yesNo(known?.tools) },
      { label: "Vision", value: yesNo(known?.vision) },
      { label: "Thinking", value: yesNo(known?.thinking) },
      { label: "Loaded", value: yesNo(known?.loaded) },
      { label: "Note", value: m.hint ?? "—" },
      {
        label: "Verified",
        value: known ? "by the model server" : "the provider does not say: unknown is unknown",
        tone: known ? "success" : "muted",
      },
      { label: "In use", value: m.id === props.current ? "yes, by the chat" : "no" },
    ];
  };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <Text>
        <Text bold color={theme.focus}>
          Models · {props.provider.name}
        </Text>
        <Text dimColor> · {models ? String(models.length) : "asking…"}</Text>
      </Text>
      <Table columns={COLUMNS} rows={rows} height={12} sortable isActive={!open} onOpen={setOpen} />
      <Text dimColor>enter inspect · ←→ r sort · esc close</Text>
      {chosen && (
        <Inspector
          title={`Model · ${chosen.name}`}
          fields={fields(chosen)}
          actions={[{ id: "use", label: "Use it in the chat" }]}
          onAction={() => {
            setOpen(undefined);
            props.onUse(chosen.id);
          }}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </Box>
  );
}
