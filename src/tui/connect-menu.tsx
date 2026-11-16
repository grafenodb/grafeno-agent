import { Box, Text, useInput, usePaste } from "ink";
import { useState, type ReactNode } from "react";
import type { ConnectionType } from "../providers/profiles.js";
import { Clickable } from "./clicks.js";
import { Picker, type PickerItem } from "./picker.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

/** Where /connect is: its menu, one of its sections, or a step inside one. */
export type ConnectSection = "menu" | ConnectionType | "list" | "manage";

/** The ways into /connect, as the menu offers them (each clickable, by number too). */
export const CONNECT_MENU: readonly (PickerItem & { readonly section: ConnectSection })[] = [
  {
    id: "cli",
    section: "cli",
    label: "1. CLI / Subscription",
    hint: "the vendors' official programs on this computer, signed in their own way",
  },
  {
    id: "api-key",
    section: "api-key",
    label: "2. API Key",
    hint: "the vendors' official APIs, with your key (billed per token, only if you allow it)",
  },
  {
    id: "coding-plan",
    section: "coding-plan",
    label: "3. Coding Plan",
    hint: "a membership or prepaid plan's own key (not an API key)",
  },
  {
    id: "local",
    section: "local",
    label: "4. Local models / Self-hosted",
    hint: "Ollama, LM Studio, Bionic or any OpenAI-compatible server of yours (no key unless it asks)",
  },
  {
    id: "manage",
    section: "manage",
    label: "5. Manage connections",
    hint: "switch on or off, check, change a key, disconnect",
  },
  {
    id: "list",
    section: "list",
    label: "6. View connections",
    hint: "each connection and its state",
  },
];

/** The words `/connect …` takes for each section. */
export function sectionOf(args: string): ConnectSection | "status" | "disconnect" | undefined {
  const word = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (word) {
    case "":
      return "menu";
    case "cli":
    case "subscription":
      return "cli";
    case "api":
    case "api-key":
    case "key":
      return "api-key";
    case "plan":
    case "plans":
    case "coding-plan":
      return "coding-plan";
    case "local":
    case "self-hosted":
    case "selfhosted":
    case "ollama":
    case "lmstudio":
    case "lm-studio":
    case "bionic":
      return "local";
    case "list":
      return "list";
    case "status":
      return "status";
    case "manage":
      return "manage";
    case "disconnect":
      return "disconnect";
    default:
      return undefined;
  }
}

/** /connect's first screen: how to connect, in five clickable choices. */
export function ConnectMenu({
  onSection,
  onCancel,
}: {
  readonly onSection: (section: ConnectSection) => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <Picker
      title="Connect · choose how"
      items={CONNECT_MENU}
      onSelect={(item) => {
        const chosen = CONNECT_MENU.find((m) => m.id === item.id);
        if (chosen) onSection(chosen.section);
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * Where a connection's key is typed: what is typed is never shown (dots
 * instead), pasting works, Enter checks it with the vendor before it is
 * kept, Escape leaves without changing anything.
 */
export function KeyEntry({
  name,
  hint,
  onSubmit,
  onCancel,
}: {
  readonly name: string;
  readonly hint?: string;
  /** Checks and keeps the key; resolves with what to say. */
  readonly onSubmit: (key: string) => Promise<{ ok: boolean; message: string }>;
  readonly onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | undefined>(undefined);

  const submit = () => {
    if (checking || value.trim() === "") return;
    setChecking(true);
    void onSubmit(value).then((result) => {
      setChecking(false);
      setSaid(result);
      if (!result.ok) setValue("");
    });
  };

  usePaste(
    (text) => {
      if (!checking) setValue((v) => v + text.replace(/\s+/g, ""));
    },
    { isActive: !checking },
  );
  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.return) submit();
      else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab) setValue((v) => v + input.trim());
    },
    { isActive: !checking },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>
        Key · {name}
      </Text>
      {hint !== undefined && <Text dimColor>{hint}</Text>}
      <Text>
        <Text dimColor>key: </Text>
        {/* Never the key itself: one dot per character. */}
        <Text color={theme.accent}>
          {value === "" ? "paste or type it" : "•".repeat(Math.min(value.length, 48))}
        </Text>
      </Text>
      {checking && (
        <Text>
          <Spinner />
          <Text dimColor> checking it with the vendor (spends nothing)…</Text>
        </Text>
      )}
      {said && <Text color={said.ok ? theme.success : theme.error}>{said.message}</Text>}
      <Box>
        <Clickable onClick={submit}>
          <Text dimColor underline>
            enter check and keep
          </Text>
        </Clickable>
        <Text dimColor> · it goes to the system's secure store, never to Grafeno · </Text>
        <Clickable onClick={onCancel}>
          <Text dimColor underline>
            esc {said?.ok ? "done" : "cancel"}
          </Text>
        </Clickable>
      </Box>
    </Box>
  );
}
