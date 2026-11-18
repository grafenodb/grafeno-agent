import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ConnectionState } from "./adapters/providers.js";
import { AgentsPanel } from "./agents-panel.js";
import type { SubAgent } from "./agents.js";
import { Clickable } from "./clicks.js";
import { windowStart } from "./picker.js";
import { theme } from "./theme.js";
import { Frame } from "./ui/frame.js";

/** One of the chat's provider's models. */
export interface ModelRow {
  readonly id: string;
  readonly name: string;
  /** Its context window, when it is known ("ctx ?" otherwise: no provider says it unasked). */
  readonly context?: number | undefined;
  /** The one the chat uses now. */
  readonly active: boolean;
}

/** A connection as the left column shows it. */
export interface ConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly state: ConnectionState;
}

/** Where the keyboard is in the left column. */
export type LeftCursor =
  | { readonly kind: "auto"; readonly id: null }
  | { readonly kind: "leader"; readonly id: null }
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

/** Rows of a list on screen at once: the list scrolls with the keyboard. */
export const LIST_ROWS = 6;

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

/** A switch, as words and a color: [ON ] or [OFF]. */
export function Switch(props: { readonly on: boolean }): ReactNode {
  return (
    <Text bold color={props.on ? theme.success : theme.muted}>
      {props.on ? "[ON ]" : "[OFF]"}
    </Text>
  );
}

/** The part of a list on screen: around the keyboard, or from the top. */
function windowOf<T>(
  items: readonly T[],
  at: number,
): { shown: readonly T[]; above: number; below: number } {
  const first = windowStart(Math.max(0, at), LIST_ROWS, items.length);
  return {
    shown: items.slice(first, first + LIST_ROWS),
    above: first,
    below: Math.max(0, items.length - first - LIST_ROWS),
  };
}

/**
 * The left column: the mode (Auto on or off, and the leader of its runs),
 * the chat's provider's models, the connections, and the agents. A double
 * click (or Enter) changes the model or the provider; a click on a switch
 * flips it. The lists scroll with the keyboard once Tab brings it here.
 */
export function LeftPanel(props: {
  readonly width: number;
  readonly auto: boolean;
  /** The leader of orchestrated runs ("provider/model"), or none. */
  readonly leader: string | undefined;
  /** The chat's provider, whose models are listed. */
  readonly providerName: string;
  readonly models: readonly ModelRow[];
  readonly connections: readonly ConnectionRow[];
  /** Connections switched Off: said as a count. */
  readonly moreConnections: number;
  readonly agents: readonly SubAgent[];
  readonly main: { readonly model: string; readonly doing: string; readonly busy: boolean };
  readonly viewing: string | undefined;
  readonly cursor?: LeftCursor | undefined;
  readonly onAuto: () => void;
  readonly onLeader: () => void;
  /** A model chosen (double click): the chat goes on with it. */
  readonly onModel: (id: string) => void;
  /** A provider chosen (double click): the chat goes on with it. */
  readonly onProvider: (id: string) => void;
  /** A row clicked once: the keyboard goes there. */
  readonly onPoint: (cursor: LeftCursor) => void;
  readonly onMenu: (cursor: LeftCursor) => void;
  readonly onAgent: (key: string | undefined) => void;
  readonly onInspectAgent: (key: string | undefined) => void;
}): ReactNode {
  const inner = props.width - 4;
  const at = props.cursor;
  const models = windowOf(
    props.models,
    at?.kind === "model"
      ? props.models.findIndex((m) => m.id === at.id)
      : props.models.findIndex((m) => m.active),
  );
  const connections = windowOf(
    props.connections,
    at?.kind === "provider" ? props.connections.findIndex((c) => c.id === at.id) : 0,
  );
  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      <Frame title="MODE" focused={at?.kind === "auto" || at?.kind === "leader"}>
        <Clickable onClick={props.onAuto}>
          <Ends
            left={
              <>
                <Text color={at?.kind === "auto" ? theme.focus : theme.muted}>
                  {at?.kind === "auto" ? "▸ " : "  "}
                </Text>
                <Text bold={props.auto}>Auto</Text>
                <Text dimColor> orchestrated</Text>
              </>
            }
            right={<Switch on={props.auto} />}
          />
        </Clickable>
        <Clickable onClick={props.onLeader}>
          <Ends
            left={
              <>
                <Text color={at?.kind === "leader" ? theme.focus : theme.muted}>
                  {at?.kind === "leader" ? "▸ " : "  "}
                </Text>
                <Text {...(props.auto ? {} : { dimColor: true })}>Leader </Text>
                <Text {...(props.leader ? { color: theme.agent } : { dimColor: true })}>
                  {props.leader ?? "none"}
                </Text>
              </>
            }
            right={<Text color={theme.focus}>[choose]</Text>}
          />
        </Clickable>
      </Frame>
      <Frame title="MODELS" note={props.providerName} focused={at?.kind === "model"}>
        {props.models.length === 0 && <Text dimColor>none listed · /connect</Text>}
        {models.above > 0 && <Text dimColor>↑ {String(models.above)} more</Text>}
        {models.shown.map((m) => {
          const on = at?.kind === "model" && at.id === m.id;
          return (
            <Clickable
              key={m.id}
              onClick={() => {
                props.onPoint({ kind: "model", id: m.id });
              }}
              onDoubleClick={() => {
                props.onModel(m.id);
              }}
              onRightClick={() => {
                props.onMenu({ kind: "model", id: m.id });
              }}
            >
              <Ends
                left={
                  <>
                    <Text color={on ? theme.focus : m.active ? theme.success : theme.muted}>
                      {on ? "▸" : m.active ? "●" : "○"}{" "}
                    </Text>
                    <Text bold={m.active} {...(on ? { color: theme.focus } : {})}>
                      {m.name}
                    </Text>
                  </>
                }
                right={
                  <Text {...(m.active ? { color: theme.success } : { dimColor: true })}>
                    {/* The context only when it is known: "unknown" would crowd the name out. */}
                    {m.active
                      ? `active${m.context === undefined ? "" : ` · ${tokens(m.context)}`}`
                      : m.context === undefined
                        ? ""
                        : tokens(m.context)}
                  </Text>
                }
              />
            </Clickable>
          );
        })}
        {models.below > 0 && <Text dimColor>↓ {String(models.below)} more</Text>}
      </Frame>
      <Frame title="PROVIDERS" focused={at?.kind === "provider"}>
        {connections.above > 0 && <Text dimColor>↑ {String(connections.above)} more</Text>}
        {connections.shown.map((c) => {
          const on = at?.kind === "provider" && at.id === c.id;
          const ok = c.state === "available";
          return (
            <Clickable
              key={c.id}
              onClick={() => {
                props.onPoint({ kind: "provider", id: c.id });
              }}
              onDoubleClick={() => {
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
        {connections.below > 0 && <Text dimColor>↓ {String(connections.below)} more</Text>}
        {props.moreConnections > 0 && (
          <Text dimColor wrap="truncate-end">
            {String(props.moreConnections)} off · /connect
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
