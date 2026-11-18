import { hostname, userInfo } from "node:os";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ConnectionState } from "./adapters/providers.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

/** A connection as the header shows it: its short name and whether it is usable now. */
export interface HeaderConnection {
  readonly id: string;
  readonly name: string;
  readonly state: ConnectionState;
}

/** Who and where: "user@host", never more (no e-mail, no path). */
export function whoAndWhere(): string {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No user to name (a container): the host alone.
  }
  const host = hostname().split(".")[0] ?? "";
  return user ? `${user}@${host}` : host;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The top of the screen: the agent and its version, what it is, and on the
 * right each connection (● usable now, ○ not), who runs it and when.
 */
export function Header(props: {
  readonly version: string;
  readonly connections: readonly HeaderConnection[];
  readonly busy: boolean;
  readonly narrow: boolean;
  readonly now: Date;
  readonly who: string;
}): ReactNode {
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.border}
    >
      <Box justifyContent="space-between" gap={2}>
        <Text wrap="truncate-end">
          <Text color={theme.brand}>◆ </Text>
          <Text bold color={theme.brand}>
            GRAFENO
          </Text>
          <Text bold> Agent</Text>
          <Text dimColor> v{props.version}</Text>
          {props.busy && (
            <Text>
              {" "}
              <Spinner />
            </Text>
          )}
        </Text>
        <Text wrap="truncate-start">
          {props.connections.map((c, i) => (
            <Text key={c.id}>
              {i > 0 ? " " : ""}
              <Text color={c.state === "available" ? theme.success : theme.muted}>
                {c.state === "available" ? "●" : "○"}
              </Text>
              <Text {...(c.state === "available" ? { color: theme.focus } : { dimColor: true })}>
                {" "}
                {c.name}
              </Text>
            </Text>
          ))}
        </Text>
      </Box>
      <Box justifyContent="space-between" gap={2}>
        <Text dimColor wrap="truncate-end">
          {props.narrow ? "long-term memory" : "CLI orchestrator · long-term memory · multi-model"}
        </Text>
        <Text dimColor wrap="truncate-start">
          {props.narrow ? "" : `${props.who} · `}
          {DATE.format(props.now)} · {TIME.format(props.now)}
        </Text>
      </Box>
    </Box>
  );
}
