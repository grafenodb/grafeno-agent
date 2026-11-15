import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Environment } from "../app/environment.js";
import type { GrafenoInfo } from "../app/services.js";
import type { Recall } from "../memory/session.js";
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
  /** What memory brought to the last message. */
  readonly recall?: Recall | undefined;
  /**
   * In Auto: each provider it includes, with its usage when the provider
   * can say it without spending anything (a plan's windows, an API key's
   * credits). Shown in place of the chat provider's plan usage.
   */
  readonly autoUsage?: readonly AutoUsage[];
}

/** One of Auto's providers in the panel. */
export interface AutoUsage {
  readonly id: string;
  readonly name: string;
  readonly usage?: ProviderUsage;
  /** Reached with an API key (its credits, when the provider reports them). */
  readonly apiKey: boolean;
  /** The provider the chat uses now. */
  readonly current: boolean;
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
      overflow="hidden"
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
        {session?.context?.window ? (
          <Meter
            used={session.context.used / session.context.window}
            width={inner}
            label={`${compact(session.context.used)} / ${compact(session.context.window)} ${String(Math.round((session.context.used / session.context.window) * 100))}%`}
          />
        ) : session?.context ? (
          <Text>{compact(session.context.used)} tokens</Text>
        ) : (
          <Text dimColor>after the first answer</Text>
        )}
      </Section>

      {props.autoUsage && props.autoUsage.length > 0 ? (
        <Section title="Usage · Auto">
          {props.autoUsage.map((member) => (
            <Box key={member.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold={member.current} {...(member.current ? { color: theme.brand } : {})}>
                  {member.name}
                </Text>
                <Text dimColor>{member.usage ? ` · ${ago(member.usage.at)}` : ""}</Text>
              </Text>
              {member.usage ? (
                member.usage.limits
                  .filter((limit) => !/fable/i.test(limit.label) || limit.used > 0)
                  .map((limit) => (
                    <Meter
                      key={limit.label}
                      used={limit.used}
                      width={inner}
                      label={`${limit.label} ${String(Math.round(limit.used * 100))}%`}
                    />
                  ))
              ) : (
                <Text dimColor wrap="truncate-end">
                  {member.apiKey
                    ? "its API does not report usage or credits"
                    : "no usage report now (not ready?)"}
                </Text>
              )}
            </Box>
          ))}
        </Section>
      ) : (
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
      )}

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
            {props.recall !== undefined && (
              <Text>
                <Text color={theme.brand}>◆</Text> last message:{" "}
                <Text bold>{String(props.recall.memories.length)}</Text> recalled
                {props.recall.facts > 0
                  ? `, ${String(props.recall.facts)} fact${props.recall.facts === 1 ? "" : "s"}`
                  : ""}
              </Text>
            )}
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
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
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

/** "Session 91%" → ["Session", "91%"]; "17.6k / 200k tokens" stays whole on the right. */
function splitLabel(label: string): [string, string] {
  const percent = /^(.*)\s(\d+%)$/.exec(label);
  return percent ? [percent[1] ?? "", percent[2] ?? ""] : ["", label];
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
  const cells = bar(used, Math.max(6, width));
  const tone = usageTone(used);
  const [name, value] = splitLabel(label);
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" width={width}>
        <Text>{name}</Text>
        <Text color={theme[tone]} bold>
          {value}
        </Text>
      </Box>
      <Text>
        <Text color={theme[tone]}>{cells.filled}</Text>
        <Text color={theme.border}>{cells.empty}</Text>
      </Text>
    </Box>
  );
}
