import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Environment } from "../app/environment.js";
import type { GrafenoInfo } from "../app/services.js";
import type { Recall } from "../memory/session.js";
import type { AgentSession } from "../app/session.js";
import type { ModelOption, ProviderStatus, ProviderUsage } from "../providers/types.js";
import { ago, bar, compact, shortResets, usageTone } from "./labels.js";
import { theme } from "./theme.js";
import { Frame } from "./ui/frame.js";
import type { RecentRun } from "../app/services.js";
import type { SubAgent } from "./agents.js";

export interface SidebarProps {
  readonly width: number;
  readonly session: AgentSession | undefined;
  readonly grafeno: GrafenoInfo;
  readonly status: ProviderStatus | undefined;
  readonly usage: ProviderUsage | undefined;
  /** The latest reading failed: `usage` is an older one. */
  readonly usageStale?: boolean;
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
  /** The sub-agent on screen: the panel shows its own details instead of the main agent's. */
  readonly agent?: SubAgent;
  /** The chat's provider is a model server of the person's own: no quota, only tokens. */
  readonly local?: boolean;
  /** Runs a command when a section is clicked (models, usage, palace). */
  readonly onCommand?: (name: string) => void;
  /** Where the keyboard is in the panel, when it has the focus. */
  readonly cursor?: SidebarSection | undefined;
  /** A right click on a section: its actions. */
  readonly onMenu?: (section: SidebarSection) => void;
  /** What the memory holds: its memories, facts and most common kinds (when Grafeno said). */
  readonly memoryStats?: MemoryStats | undefined;
  /** The project's latest runs. */
  readonly runs?: readonly RecentRun[] | undefined;
}

/** What the memory holds, as the panel shows it. */
export interface MemoryStats {
  readonly nodes: number;
  readonly edges: number;
  /** The most common kinds of memory, with how many of each. */
  readonly labels: readonly (readonly [string, number])[];
}

/** The sections the keyboard moves through (each opens a command, and has actions). */
export const SIDEBAR_SECTIONS = ["usage", "memory", "runs"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/** One of Auto's providers in the panel. */
export interface AutoUsage {
  readonly id: string;
  readonly name: string;
  readonly usage?: ProviderUsage;
  /** Reached with an API key (its credits, when the provider reports them). */
  readonly apiKey: boolean;
  /** The provider the chat uses now. */
  readonly current: boolean;
  /** The latest reading failed: `usage` is an older one. */
  readonly stale?: boolean;
  /** A model server of the person's own: it has no quota; only its tokens are shown. */
  readonly local?: boolean;
  /** The tokens it spent answering the chat in this session. */
  readonly tokens?: { readonly input: number; readonly output: number };
}

/** The right column: the plan's real usage, what the memory holds, the latest runs. */
export function Sidebar(props: SidebarProps): ReactNode {
  const { session, width } = props;
  const inner = width - 4;
  if (props.agent) {
    return (
      <Box flexDirection="column" width={width} flexShrink={0} overflow="hidden">
        <AgentDetails agent={props.agent} width={inner} />
      </Box>
    );
  }
  const usage = props.usage;
  return (
    <Box flexDirection="column" width={width} flexShrink={0} overflow="hidden">
      <Section
        title={
          props.autoUsage && props.autoUsage.length > 0
            ? "PLAN USAGE · AUTO"
            : props.local
              ? "TOKENS · LOCAL"
              : "PLAN USAGE"
        }
        color={theme.user}
        note={
          !props.autoUsage?.length && !props.local
            ? [props.status?.plan, usage ? ago(usage.at) : undefined].filter(Boolean).join(" · ") ||
              undefined
            : undefined
        }
        {...click(props, "usage refresh")}
        {...pick(props, "usage")}
      >
        {props.autoUsage && props.autoUsage.length > 0 ? (
          props.autoUsage.map((member) => (
            <Box key={member.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold={member.current} {...(member.current ? { color: theme.brand } : {})}>
                  {member.name}
                </Text>
                <Text dimColor>{member.usage ? ` · ${ago(member.usage.at)}` : ""}</Text>
                {member.stale ? <Text color={theme.warning}> · old</Text> : null}
              </Text>
              {member.local ? (
                <Text dimColor wrap="truncate-end">
                  local · no quota ·{" "}
                  {member.tokens
                    ? `${compact(member.tokens.input)} in · ${compact(member.tokens.output)} out`
                    : "no tokens yet"}
                </Text>
              ) : member.usage ? (
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
                    : "no usage report now"}
                </Text>
              )}
            </Box>
          ))
        ) : props.local ? (
          <Text dimColor wrap="wrap">
            A model of your own: no quota or credits to spend.
          </Text>
        ) : usage ? (
          usage.limits
            .filter((limit) => !/fable/i.test(limit.label) || limit.used > 0)
            .map((limit) => (
              <Box key={limit.label} flexDirection="column">
                <Meter
                  used={limit.used}
                  width={inner}
                  label={`${limit.label} ${String(Math.round(limit.used * 100))}%`}
                />
                {limit.resets !== undefined && (
                  <Text dimColor>resets {shortResets(limit.resets)}</Text>
                )}
              </Box>
            ))
        ) : (
          <Text dimColor>checking…</Text>
        )}
        {usage && props.usageStale ? (
          <Text color={theme.warning} wrap="wrap">
            The latest reading failed: trying again each minute.
          </Text>
        ) : null}
        {session?.context?.window ? (
          <Meter
            used={session.context.used / session.context.window}
            width={inner}
            label={`Context ${compact(session.context.used)} / ${compact(session.context.window)}`}
          />
        ) : null}
        {session && (
          <Text dimColor wrap="truncate-end">
            {String(session.turns)} turn{session.turns === 1 ? "" : "s"} ·{" "}
            {compact(
              session.usage.inputTokens +
                session.usage.cacheReadTokens +
                session.usage.cacheWriteTokens,
            )}{" "}
            in · {compact(session.usage.outputTokens)} out
          </Text>
        )}
      </Section>

      <Section
        title="MEMORY"
        color={theme.memory}
        note={props.grafeno.mode === "included" ? "included" : "server"}
        {...click(props, "vault")}
        {...pick(props, "memory")}
      >
        {props.memoryStats ? (
          <>
            <Text wrap="truncate-end">
              <Text bold>{props.memoryStats.nodes.toLocaleString()}</Text> memories ·{" "}
              {props.memoryStats.edges.toLocaleString()} facts
            </Text>
            {props.memoryStats.labels.length > 0 && (
              <Box flexWrap="wrap" columnGap={1}>
                {props.memoryStats.labels.map(([label]) => (
                  <Text key={label} backgroundColor={theme.panel} color={theme.memory}>
                    {` ${label} `}
                  </Text>
                ))}
              </Box>
            )}
          </>
        ) : session ? null : (
          <Text dimColor>/palace to set up</Text>
        )}
        {session && (
          <>
            <Ends
              left={`• palace ${session.memory.palace}`}
              right={session.memory.palace === session.memory.project.name ? "project" : "shared"}
            />
            <Ends
              left={`• agent ${session.identity?.name ?? "unnamed"}`}
              right={session.identity?.ownOnly ? "own" : "shared"}
            />
            <Ends left={`• ${session.vault.namespace}`} right="namespace" />
            {props.recall !== undefined && (
              <Text wrap="truncate-end">
                <Text color={theme.memory}>◆</Text> last message:{" "}
                <Text bold>{String(props.recall.memories.length)}</Text> recalled
                {props.recall.facts > 0
                  ? `, ${String(props.recall.facts)} fact${props.recall.facts === 1 ? "" : "s"}`
                  : ""}
              </Text>
            )}
          </>
        )}
      </Section>

      <Section
        title="RUNS"
        color={theme.accent}
        grow
        {...click(props, "runs")}
        {...pick(props, "runs")}
      >
        {props.runs === undefined || props.runs.length === 0 ? (
          <Text dimColor>none yet · /orchestrate</Text>
        ) : (
          props.runs.map((run) => (
            <Ends
              key={run.id}
              left={
                <>
                  <Text color={RUN_LOOK[run.state]?.color ?? theme.muted}>
                    {RUN_LOOK[run.state]?.mark ?? "·"}{" "}
                  </Text>
                  {run.request}
                </>
              }
              right={<Text dimColor>{duration(run.seconds, run.state)}</Text>}
            />
          ))
        )}
      </Section>
    </Box>
  );
}

/** How a run's state is shown: a mark, and its color. */
const RUN_LOOK: Readonly<Record<string, { readonly mark: string; readonly color: string }>> = {
  completed: { mark: "✓", color: theme.success },
  failed: { mark: "✗", color: theme.error },
  running: { mark: "◌", color: theme.warning },
  paused: { mark: "‖", color: theme.warning },
  waiting: { mark: "◌", color: theme.warning },
  cancelled: { mark: "–", color: theme.muted },
};

/** How long a run took ("…" while it goes on). */
function duration(seconds: number, state: string): string {
  if (state === "running" || state === "waiting") return "…";
  if (seconds < 60) return `${String(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${String(m)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A label and a value at the two ends of a line. */
function Ends(props: { readonly left: ReactNode; readonly right: ReactNode }): ReactNode {
  return (
    <Box justifyContent="space-between" gap={1}>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{props.left}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{props.right}</Text>
      </Box>
    </Box>
  );
}

/** The click of a section that opens a command, when the panel was given one. */
function click(props: SidebarProps, command: string): { onClick?: () => void } {
  const run = props.onCommand;
  return run
    ? {
        onClick: () => {
          run(command);
        },
      }
    : {};
}

/** A section's place under the keyboard, and its actions on a right click. */
function pick(
  props: SidebarProps,
  section: SidebarSection,
): { cursor: boolean; onRightClick?: () => void } {
  const menu = props.onMenu;
  return {
    cursor: props.cursor === section,
    ...(menu
      ? {
          onRightClick: () => {
            menu(section);
          },
        }
      : {}),
  };
}

function Section({
  title,
  note,
  children,
  onClick,
  onRightClick,
  cursor = false,
  color = theme.accent,
  grow = false,
}: {
  readonly title: string;
  readonly note?: string | undefined;
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly onRightClick?: (() => void) | undefined;
  /** The keyboard is on it (the panel has the focus). */
  readonly cursor?: boolean;
  /** Its title's color: what the section is about. */
  readonly color?: string;
  /** Takes the room left in the column. */
  readonly grow?: boolean;
}): ReactNode {
  return (
    <Frame
      title={title.toUpperCase()}
      color={color}
      note={note}
      focused={cursor}
      grow={grow}
      onClick={onClick}
      onRightClick={onRightClick}
    >
      {children}
    </Frame>
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

/** A sub-agent's own details: its task, model, tokens, context and where it works. */
function AgentDetails({
  agent,
  width,
}: {
  readonly agent: SubAgent;
  readonly width: number;
}): ReactNode {
  const seconds = agent.started
    ? Math.max(0, (Date.now() - agent.started.getTime()) / 1000)
    : undefined;
  return (
    <>
      <Section title="Sub-agent">
        <Text bold wrap="truncate-end">
          {agent.id}
        </Text>
        <Text dimColor wrap="wrap">
          {agent.title}
        </Text>
        <Text>
          <Text color={theme.accent}>{agent.state}</Text>
          {agent.doing && agent.state === "running" ? <Text dimColor> · {agent.doing}</Text> : null}
        </Text>
        {agent.reason ? (
          <Text color={theme.warning} wrap="wrap">
            {agent.reason.split("\n", 1)[0]}
          </Text>
        ) : null}
      </Section>
      <Section title="Model">
        {agent.model ? (
          <>
            <Text bold wrap="truncate-end">
              {agent.model}
            </Text>
            <Text dimColor>
              {[agent.tier, agent.effort].filter(Boolean).join(" · ") || "the model's own effort"}
            </Text>
            {agent.exactModel && agent.exactModel !== agent.model ? (
              <Text dimColor wrap="truncate-end">
                {agent.exactModel}
              </Text>
            ) : null}
          </>
        ) : (
          <Text dimColor>not started yet</Text>
        )}
      </Section>
      <Section title="Context">
        {agent.context?.window ? (
          <Meter
            used={agent.context.used / agent.context.window}
            width={width}
            label={`${compact(agent.context.used)} / ${compact(agent.context.window)} ${String(Math.round((agent.context.used / agent.context.window) * 100))}%`}
          />
        ) : agent.context ? (
          <Text>{compact(agent.context.used)} tokens</Text>
        ) : (
          <Text dimColor>after its first answer</Text>
        )}
      </Section>
      <Section title="Tokens">
        {agent.tokens ? (
          <Text>
            {compact(agent.tokens.input + agent.tokens.cache)} in · {compact(agent.tokens.output)}{" "}
            out
          </Text>
        ) : (
          <Text dimColor>—</Text>
        )}
        {seconds !== undefined && agent.state === "running" ? (
          <Text dimColor>
            working for{" "}
            {seconds < 60
              ? `${String(Math.round(seconds))} s`
              : `${String(Math.round(seconds / 60))} min`}
          </Text>
        ) : null}
      </Section>
      {agent.folder ? (
        <Section title="Works in">
          <Text dimColor wrap="truncate-start">
            {agent.folder}
          </Text>
          {agent.branch ? (
            <Text dimColor wrap="truncate-end">
              {agent.branch}
            </Text>
          ) : null}
        </Section>
      ) : null}
      {agent.lastReport ? (
        <Section title="Last report">
          <Text wrap="wrap">{agent.lastReport}</Text>
        </Section>
      ) : null}
    </>
  );
}
