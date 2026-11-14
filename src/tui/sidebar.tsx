import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Environment } from "../app/environment.js";
import type { GrafenoInfo } from "../app/services.js";
import type { AgentSession } from "../app/session.js";
import type { ModelOption, ProviderStatus, ProviderUsage } from "../providers/types.js";
import { ago, bar, compact, modelLine, shortPath, shortResets, usageTone } from "./labels.js";
import { Glyph } from "./logo.js";
import { theme } from "./theme.js";

export interface SidebarProps {
  readonly width: number;
  readonly session: AgentSession | undefined;
  readonly grafeno: GrafenoInfo;
  readonly status: ProviderStatus | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly models: readonly ModelOption[];
  readonly environment: Environment;
}

/** The side panel: the model, how full its context is, the plan's real usage, where the agent works and its memory. */
export function Sidebar(props: SidebarProps): ReactNode {
  const { session, width } = props;
  const inner = width - 4;
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.border}
      paddingX={1}
    >
      <Text>
        <Glyph />{" "}
        <Text bold color={theme.brand}>
          GRAFENO AGENT
        </Text>
      </Text>

      <Section title="Model">
        {session ? (
          <>
            <Text bold>{modelLine(session, props.models)}</Text>
            <Text dimColor>
              {session.provider.name}
              {props.status?.plan ? ` · ${props.status.plan}` : ""}
            </Text>
          </>
        ) : (
          <Text dimColor>not connected</Text>
        )}
        {props.status && !props.status.signedIn && (
          <Text color={theme.warning}>not signed in · /connect</Text>
        )}
      </Section>

      <Section title="Context">
        {session?.context ? (
          <Meter
            used={session.context.window ? session.context.used / session.context.window : 0}
            width={inner}
            label={`${compact(session.context.used)}${session.context.window ? ` / ${compact(session.context.window)}` : ""} tokens`}
          />
        ) : (
          <Text dimColor>after the first answer</Text>
        )}
      </Section>

      <Section title="Plan usage" note={props.usage ? ago(props.usage.at) : undefined}>
        {props.usage ? (
          props.usage.limits
            .filter((limit) => !/fable/i.test(limit.label) || limit.used > 0)
            .map((limit) => (
              <Box key={limit.label} flexDirection="column">
                <Meter
                  used={limit.used}
                  width={inner}
                  label={`${limit.label} ${String(Math.round(limit.used * 100))}%`}
                />
                {limit.resets !== undefined && (
                  <Text dimColor> resets {shortResets(limit.resets)}</Text>
                )}
              </Box>
            ))
        ) : (
          <Text dimColor>checking…</Text>
        )}
      </Section>

      <Section title="This session">
        {session ? (
          <Text>
            {String(session.turns)} turn{session.turns === 1 ? "" : "s"} ·{" "}
            {compact(
              session.usage.inputTokens +
                session.usage.cacheReadTokens +
                session.usage.cacheWriteTokens,
            )}{" "}
            in · {compact(session.usage.outputTokens)} out
          </Text>
        ) : (
          <Text dimColor>—</Text>
        )}
      </Section>

      <Section title="Environment">
        {session ? (
          <>
            <Text bold>{session.memory.project.name}</Text>
            {props.environment.branch !== undefined && (
              <Text>
                <Text color={theme.accent}>⎇ {props.environment.branch}</Text>
                <Text dimColor>
                  {props.environment.changes
                    ? ` · ${String(props.environment.changes)} changed`
                    : " · clean"}
                  {props.environment.ahead ? ` · ${String(props.environment.ahead)} to push` : ""}
                </Text>
              </Text>
            )}
            <Text dimColor>{shortPath(session.workspace.root, inner)}</Text>
          </>
        ) : (
          <Text dimColor>—</Text>
        )}
      </Section>

      <Section title="Memory">
        <Text>
          {props.grafeno.mode === "included" ? "Grafeno included" : "Grafeno server"}
          <Text dimColor> · {props.grafeno.url.replace(/^https?:\/\//, "")}</Text>
        </Text>
        {session ? (
          <>
            <Text dimColor>
              palace {session.memory.palace}
              {session.memory.palace === session.memory.project.name ? " (shared)" : ""}
            </Text>
            <Text dimColor>
              agent {session.identity?.name ?? "unnamed"}
              {session.identity?.ownOnly ? " · own-only" : ""}
            </Text>
          </>
        ) : (
          <Text dimColor>/palace to set up</Text>
        )}
      </Section>
    </Box>
  );
}

function Section({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color={theme.accent}>
          {title.toUpperCase()}
        </Text>
        {note !== undefined && <Text dimColor> · {note}</Text>}
      </Text>
      {children}
    </Box>
  );
}

function Meter({
  used,
  width,
  label,
}: {
  readonly used: number;
  readonly width: number;
  readonly label: string;
}): ReactNode {
  const cells = bar(used, Math.max(6, Math.min(16, width - label.length - 1)));
  const tone = usageTone(used);
  return (
    <Text>
      <Text color={theme[tone]}>{cells.filled}</Text>
      <Text color={theme.border}>{cells.empty}</Text>
      <Text> {label}</Text>
    </Text>
  );
}
