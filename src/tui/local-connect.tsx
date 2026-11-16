import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import type { ConnectionActionsApi } from "../app/connections.js";
import { describeModel, type Discovery } from "../providers/local/discover.js";
import { localityText, type Locality } from "../providers/local/endpoint.js";
import {
  LOCAL_KIND_INFO,
  loadLocalConnections,
  type LocalConnection,
  type LocalKind,
} from "../providers/local/store.js";
import { KeyEntry } from "./connect-menu.js";
import { Picker } from "./picker.js";
import { Prompt } from "./prompt.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export interface LocalPanelProps {
  readonly actions: Pick<
    ConnectionActionsApi,
    "checkServer" | "saveServer" | "setServerModel" | "removeServer"
  >;
  /** Opens the local connections as providers: use one for the chat, put it in Auto, its models. */
  readonly onUse: () => void;
  /** Leaves the panel, with what to say. */
  readonly onDone: (message?: string, tone?: "success" | "warning" | "error") => void;
  readonly onCancel: () => void;
  /** Where the connections are kept; for tests. */
  readonly file?: string;
}

/** What is being set up: a kind, its address, its key, and the connection it changes (when it does). */
interface Draft {
  readonly kind: LocalKind;
  readonly url?: string;
  readonly key?: string;
  readonly id?: string;
  readonly found?: Discovery;
  readonly locality?: Locality;
}

type Step =
  | { readonly kind: "list" }
  | { readonly kind: "url"; readonly draft: Draft }
  | { readonly kind: "key"; readonly draft: Draft }
  | { readonly kind: "models"; readonly draft: Draft }
  | { readonly kind: "actions"; readonly connection: LocalConnection }
  | { readonly kind: "remove"; readonly connection: LocalConnection };

const ADD: readonly { readonly kind: LocalKind; readonly label: string }[] = [
  { kind: "ollama", label: "+ Ollama" },
  { kind: "lmstudio", label: "+ LM Studio" },
  { kind: "bionic", label: "+ Bionic" },
  { kind: "openai-compatible", label: "+ Custom OpenAI-compatible endpoint" },
];

/**
 * /connect's local models and self-hosted servers: Ollama, LM Studio,
 * Bionic, or any OpenAI-compatible endpoint. Each is set up by its
 * address, checked (where it leads, what it answers) before it is kept;
 * a key only when the server asks for one; then its default model, chosen
 * among those the server lists with what each can do. Several of a kind
 * may be kept.
 */
export function LocalPanel(props: LocalPanelProps): ReactNode {
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const connections = loadLocalConnections(...(props.file ? [props.file] : []));

  /** Checks the address (and key) of a draft; on to the key or the models, or says why not. */
  const check = (draft: Draft) => {
    if (!draft.url) return;
    setBusy(`Checking ${LOCAL_KIND_INFO[draft.kind].name} at ${draft.url}`);
    setError(undefined);
    void props.actions.checkServer(draft.kind, draft.url, draft.key).then((result) => {
      setBusy(undefined);
      if (result.ok) {
        setStep({
          kind: "models",
          draft: { ...draft, url: result.url, found: result.found, locality: result.locality },
        });
      } else if (result.needsKey && draft.key === undefined) {
        setStep({ kind: "key", draft });
      } else {
        setError(result.message);
        setStep({ kind: "url", draft });
      }
    });
  };

  const save = (draft: Draft, defaultModel?: string) => {
    if (!draft.url) return;
    setBusy("Keeping the connection");
    void props.actions
      .saveServer({
        kind: draft.kind,
        url: draft.url,
        ...(draft.id ? { id: draft.id } : {}),
        ...(draft.key ? { key: draft.key } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        ...(draft.locality ? { locality: draft.locality } : {}),
      })
      .then(
        (saved) => {
          setBusy(undefined);
          props.onDone(saved.message, "success");
        },
        (e: unknown) => {
          setBusy(undefined);
          setError(e instanceof Error ? e.message : String(e));
          setStep({ kind: "list" });
        },
      );
  };

  useInput(
    (input, key) => {
      if (step.kind === "url" && key.escape) setStep({ kind: "list" });
      if (step.kind === "remove") {
        if (input === "y" || input === "Y") {
          const target = step.connection;
          void props.actions.removeServer(target.id).then((said) => {
            props.onDone(said, "success");
          });
        } else if (input === "n" || input === "N" || key.escape) {
          setStep({ kind: "actions", connection: step.connection });
        }
      }
    },
    { isActive: busy === undefined && (step.kind === "url" || step.kind === "remove") },
  );

  if (busy !== undefined) {
    return (
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1}>
        <Spinner />
        <Text dimColor> {busy}… (nothing is sent but a look at what the server offers)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {error !== undefined && <Text color={theme.error}>✗ {error}</Text>}
      {step.kind === "list" && (
        <Picker
          title="Local models / Self-hosted"
          rows={12}
          items={[
            {
              id: "+use",
              label: "Use a connection",
              hint: "for the chat, in Auto, or choose its models",
            },
            ...connections.map((c) => ({
              id: c.id,
              label: `${c.id} · ${c.name}`,
              hint: `${c.url}${c.defaultModel ? ` · ${c.defaultModel}` : ""}`,
            })),
            ...ADD.map((a) => ({
              id: `+${a.kind}`,
              label: a.label,
              hint: LOCAL_KIND_INFO[a.kind].defaultUrl ?? "its address",
            })),
          ]}
          onCancel={props.onCancel}
          onSelect={(item) => {
            setError(undefined);
            if (item.id === "+use") {
              props.onUse();
              return;
            }
            const adding = ADD.find((a) => `+${a.kind}` === item.id);
            if (adding) {
              setStep({ kind: "url", draft: { kind: adding.kind } });
              return;
            }
            const chosen = connections.find((c) => c.id === item.id);
            if (chosen) setStep({ kind: "actions", connection: chosen });
          }}
        />
      )}
      {step.kind === "url" && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
          <Text bold color={theme.brand}>
            {LOCAL_KIND_INFO[step.draft.kind].name} · its address
          </Text>
          <Prompt
            active
            commands={false}
            initial={step.draft.url ?? LOCAL_KIND_INFO[step.draft.kind].defaultUrl ?? "https://"}
            placeholder="such as http://localhost:11434"
            onSubmit={(text) => {
              const url = text.trim();
              if (url === "") return;
              const draft = { ...step.draft, url };
              // A server that always asks for a key: the key first.
              if (LOCAL_KIND_INFO[draft.kind].key === "required" && draft.key === undefined) {
                setStep({ kind: "key", draft });
              } else check(draft);
            }}
          />
          <Text dimColor>
            enter check it (where it leads, what it offers) · esc back · a key only if it asks
          </Text>
        </Box>
      )}
      {step.kind === "key" && (
        <KeyEntry
          name={LOCAL_KIND_INFO[step.draft.kind].name}
          hint={
            LOCAL_KIND_INFO[step.draft.kind].key === "required"
              ? "This server needs a key (made in its own settings)."
              : "This server asks for a key: the one its authentication setting gave you."
          }
          onSubmit={(key) => {
            const draft = { ...step.draft, key };
            return props.actions.checkServer(draft.kind, draft.url ?? "", key).then((result) => {
              if (result.ok) {
                setStep({
                  kind: "models",
                  draft: {
                    ...draft,
                    url: result.url,
                    found: result.found,
                    locality: result.locality,
                  },
                });
              }
              return { ok: result.ok, message: result.ok ? "Accepted." : result.message };
            });
          }}
          onCancel={() => {
            setStep({ kind: "url", draft: step.draft });
          }}
        />
      )}
      {step.kind === "models" && (
        <Box flexDirection="column">
          <Text color={theme.success}>
            ✓ {LOCAL_KIND_INFO[step.draft.kind].name}
            {step.draft.found?.version ? ` ${step.draft.found.version}` : ""} answers at{" "}
            {step.draft.url}
            {step.draft.locality ? ` (${localityText(step.draft.locality)})` : ""}:{" "}
            {String(step.draft.found?.models.length ?? 0)} models
          </Text>
          <Picker
            title="Its default model (the one used when none is chosen)"
            rows={12}
            items={[
              {
                id: "",
                label: "No default",
                hint: "a loaded model that takes tools, else the first listed",
              },
              ...(step.draft.found?.models ?? []).map((m) => ({
                id: m.id,
                label: m.name === m.id ? m.id : `${m.name} (${m.id})`,
                hint: describeModel(m),
              })),
            ]}
            onCancel={() => {
              setStep({ kind: "url", draft: step.draft });
            }}
            onSelect={(item) => {
              save(step.draft, item.id === "" ? undefined : item.id);
            }}
          />
        </Box>
      )}
      {step.kind === "actions" && (
        <Picker
          title={`${step.connection.name} · ${step.connection.url}`}
          items={[
            {
              id: "check",
              label: "Check now",
              hint: "what it answers and offers (spends nothing)",
            },
            {
              id: "model",
              label: "Choose its default model",
              hint: step.connection.defaultModel ?? "none",
            },
            { id: "url", label: "Change its address", hint: step.connection.url },
            {
              id: "key",
              label: step.connection.hasKey ? "Change its key" : "Set a key",
              hint: "only for a server that asks for one",
            },
            {
              id: "remove",
              label:
                step.connection.id === "ollama" || step.connection.id === "lmstudio"
                  ? "Reset to its documented address"
                  : "Remove",
              hint: "its key goes too",
            },
            { id: "back", label: "Back" },
          ]}
          onCancel={() => {
            setStep({ kind: "list" });
          }}
          onSelect={(item) => {
            const c = step.connection;
            const draft: Draft = { kind: c.kind, url: c.url, id: c.id };
            switch (item.id) {
              case "check":
                setBusy(`Checking ${c.name}`);
                void props.actions.checkServer(c.kind, c.url).then((result) => {
                  setBusy(undefined);
                  props.onDone(
                    result.ok
                      ? `${c.name}${result.found.version ? ` ${result.found.version}` : ""} answers at ${result.url} (${localityText(result.locality)}): ${String(result.found.models.length)} models, ${String(result.found.models.filter((m) => m.tools === true).length)} take tools.`
                      : result.message,
                    result.ok ? "success" : "warning",
                  );
                });
                break;
              case "model":
                check(draft);
                break;
              case "url":
                setStep({ kind: "url", draft });
                break;
              case "key":
                setStep({ kind: "key", draft });
                break;
              case "remove":
                setStep({ kind: "remove", connection: c });
                break;
              default:
                setStep({ kind: "list" });
            }
          }}
        />
      )}
      {step.kind === "remove" && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.error} paddingX={1}>
          <Text color={theme.warning}>
            {step.connection.id === "ollama" || step.connection.id === "lmstudio"
              ? `Reset ${step.connection.name} to its documented address, with no default model or key?`
              : `Remove ${step.connection.name} (${step.connection.url})? Its key goes too; the server itself is not touched.`}
          </Text>
          <Text dimColor>y yes · n no</Text>
        </Box>
      )}
    </Box>
  );
}
