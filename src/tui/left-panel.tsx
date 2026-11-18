import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ConnectionState } from "./adapters/providers.js";
import { AgentsPanel } from "./agents-panel.js";
import type { SubAgent } from "./agents.js";
import { Clickable } from "./clicks.js";
import { theme } from "./theme.js";
import { Frame } from "./ui/frame.js";

/** A model as the left column shows it: the one each provider uses now. */
export interface ModelRow {
  readonly id: string;
  readonly name: string;
  /** Who serves it: the connection's name. */
  readonly vendor: string;
  /** Its context window, when it is known ("ctx ?" otherwise: no provider says it unasked). */
  readonly context?: number | undefined;
  /** active: the chat's; ready: another provider's, usable; local: a model server of yours. */
  readonly state: "active" | "ready" | "local" | "off";
}

/** A connection as the left column shows it. */
export interface ConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly state: ConnectionState;
}

/** Where the keyboard is in the left column. */
export type LeftCursor =
  | { readonly kind: "model"; readonly id: string }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string | null };

const WORD: Readonly<Record<ConnectionState, string>> = {
  available: "OK",
  connected: "held",
  configured: "sign in",
  unavailable: "—",
  error: "error",
};

const tokens = (n: number | undefined) =>
  n === undefined
    ? "ctx ?"
    : `ctx ${n >= 1_000_000 ? `${String(Math.round(n / 100_000) / 10)}M` : `${String(Math.round(n / 1000))}K`}`;

/** A label and a value at the two ends of a line. */
function Ends(props: { readonly left: ReactNode; readonly right: ReactNode }): ReactNode {
  return (
    <Box justifyContent="space-between" gap={1}>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{props.left}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>{props.right}</Text>
      </Box>
    </Box>
  );
}

/**
 * The left column: the models each provider uses now, the connections and
 * how each stands, and the agents (the main one, and a run's sub-agents).
 * A click opens what a row is about; the keyboard moves through all of it
 * once Tab brings the keys here.
 */
export function LeftPanel(props: {
  readonly width: number;
  readonly models: readonly ModelRow[];
  readonly connections: readonly ConnectionRow[];
  /** Connections left out (not in use, not ready): said as a count. */
  readonly moreConnections: number;
  readonly agents: readonly SubAgent[];
  readonly main: { readonly model: string; readonly doing: string; readonly busy: boolean };
  readonly viewing: string | undefined;
  readonly cursor?: LeftCursor | undefined;
  readonly onModel: (id: string) => void;
  readonly onProvider: (id: string) => void;
  readonly onMenu: (cursor: LeftCursor) => void;
  readonly onAgent: (key: string | undefined) => void;
  readonly onInspectAgent: (key: string | undefined) => void;
}): ReactNode {
  const inner = props.width - 4;
  const at = props.cursor;
  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      <Frame title="MODELS" focused={at?.kind === "model"}>
        {props.models.length === 0 && <Text dimColor>none ready · /connect</Text>}
        {props.models.map((m) => {
          const on = at?.kind === "model" && at.id === m.id;
          return (
            <Clickable
              key={m.id}
              flexDirection="column"
              onClick={() => {
                props.onModel(m.id);
              }}
              onRightClick={() => {
                props.onMenu({ kind: "model", id: m.id });
              }}
            >
              <Ends
                left={
                  <>
                    <Text
                      color={on ? theme.focus : m.state === "active" ? theme.success : theme.muted}
                    >
                      {on ? "▸" : m.state === "active" ? "●" : "○"}{" "}
                    </Text>
                    <Text bold={m.state === "active"} {...(on ? { color: theme.focus } : {})}>
                      {m.name}
                    </Text>
                  </>
                }
                right={
                  <Text {...(m.state === "active" ? { color: theme.success } : { dimColor: true })}>
                    {m.state}
                  </Text>
                }
              />
              <Ends
                left={<Text dimColor> {m.vendor}</Text>}
                right={<Text dimColor>{tokens(m.context)}</Text>}
              />
            </Clickable>
          );
        })}
      </Frame>
      <Frame title="PROVIDERS" focused={at?.kind === "provider"}>
        {props.connections.map((c) => {
          const on = at?.kind === "provider" && at.id === c.id;
          const ok = c.state === "available";
          return (
            <Clickable
              key={c.id}
              onClick={() => {
                props.onProvider(c.id);
              }}
              onRightClick={() => {
                props.onMenu({ kind: "provider", id: c.id });
              }}
            >
              <Ends
                left={
                  <>
                    <Text color={on ? theme.focus : ok ? theme.success : theme.muted}>
                      {on ? "▸" : ok ? "●" : "○"}{" "}
                    </Text>
                    <Text {...(on ? { color: theme.focus } : ok ? {} : { dimColor: true })}>
                      {c.name}
                    </Text>
                  </>
                }
                right={
                  <Text
                    {...(ok
                      ? { color: theme.success }
                      : c.state === "error"
                        ? { color: theme.error }
                        : c.state === "unavailable"
                          ? { dimColor: true }
                          : { color: theme.warning })}
                  >
                    {WORD[c.state]}
                  </Text>
                }
              />
            </Clickable>
          );
        })}
        {props.moreConnections > 0 && (
          <Text dimColor wrap="truncate-end">
            +{String(props.moreConnections)} more · /providers
          </Text>
        )}
      </Frame>
      <Frame title="AGENTS" color={theme.agent} focused={at?.kind === "agent"} grow>
        <AgentsPanel
          bare
          width={inner}
          main={props.main}
          agents={props.agents}
          viewing={props.viewing}
          cursor={at?.kind === "agent" ? at.id : undefined}
          onSelect={props.onAgent}
          onInspect={props.onInspectAgent}
          onMenu={(key) => {
            props.onMenu({ kind: "agent", id: key ?? null });
          }}
        />
      </Frame>
    </Box>
  );
}
