import { Box, Text } from "ink";
import { useState, type ReactNode } from "react";
import { ActionGroup, type ActionRecord } from "./activity.js";
import type { AgentLine, SubAgent } from "./agents.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";
import { Clickable } from "./clicks.js";

/** The key of a sub-agent in the panel: its run and task. */
export function agentKey(agent: Pick<SubAgent, "runId" | "id">): string {
  return `${agent.runId}:${agent.id}`;
}

const MARK: Record<SubAgent["state"], { mark: string; color: string }> = {
  pending: { mark: "○", color: theme.muted },
  ready: { mark: "◌", color: theme.accent },
  running: { mark: "●", color: theme.accent },
  blocked: { mark: "⊘", color: theme.warning },
  review: { mark: "?", color: theme.warning },
  completed: { mark: "✓", color: theme.success },
  failed: { mark: "✗", color: theme.error },
  cancelled: { mark: "–", color: theme.muted },
};

/**
 * The left panel: the main agent (the chat) and the sub-agents its runs
 * started, each with its model and what it is doing now. The one being
 * viewed is marked; ctrl+n and ctrl+p go through them.
 */
export function AgentsPanel({
  width,
  main,
  agents,
  viewing,
  onSelect,
}: {
  readonly width: number;
  readonly main: { readonly model: string; readonly doing: string; readonly busy: boolean };
  readonly agents: readonly SubAgent[];
  /** The key of the agent shown, or undefined for the main one. */
  readonly viewing: string | undefined;
  /** Called with the agent clicked (undefined: the main one). */
  readonly onSelect?: (key: string | undefined) => void;
}): ReactNode {
  const running = agents.filter((a) => a.state === "running").length;
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor={theme.muted}
      paddingRight={1}
    >
      <Text bold color={theme.brand}>
        AGENTS
      </Text>
      <Text dimColor>
        {String(running)} of {String(agents.length)} sub-agents working
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Entry
          selected={viewing === undefined}
          mark={main.busy ? <Spinner /> : <Text color={theme.success}>◆</Text>}
          title="Orchestrator"
          subtitle={main.model}
          state={main.doing}
          width={width}
          depth={0}
          {...(onSelect
            ? {
                onClick: () => {
                  onSelect(undefined);
                },
              }
            : {})}
        />
        {agents.map((agent, index) => {
          const look = MARK[agent.state];
          const model = [agent.model, agent.effort].filter(Boolean).join(" · ");
          return (
            <Entry
              key={agentKey(agent)}
              selected={viewing === agentKey(agent)}
              mark={
                agent.state === "running" ? (
                  <Spinner />
                ) : (
                  <Text color={look.color}>{look.mark}</Text>
                )
              }
              title={agent.title || agent.id}
              subtitle={model || "no model yet"}
              state={agent.doing ?? agent.state}
              width={width}
              depth={1}
              last={index === agents.length - 1}
              {...(onSelect
                ? {
                    onClick: () => {
                      onSelect(agentKey(agent));
                    },
                  }
                : {})}
            />
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          click one, or ctrl+n / ctrl+p (▌ the one on screen) · /agents
        </Text>
      </Box>
    </Box>
  );
}

function Entry({
  selected,
  mark,
  title,
  subtitle,
  state,
  width,
  depth,
  last = false,
  onClick,
}: {
  readonly onClick?: () => void;
  readonly selected: boolean;
  readonly mark: ReactNode;
  /** The orchestrator, or a sub-agent's task. */
  readonly title: string;
  /** The model it uses. */
  readonly subtitle: string;
  /** What it is doing now: waiting, thinking, a tool, done. */
  readonly state: string;
  readonly width: number;
  /** 0 for the orchestrator, 1 for its sub-agents: drawn as a tree under it. */
  readonly depth: 0 | 1;
  readonly last?: boolean;
}): ReactNode {
  // Sub-agents hang from the orchestrator: a branch for the title, a stem
  // beside the lines under it (none under the last one).
  const branch = depth === 0 ? "" : last ? "└─" : "├─";
  const stem = depth === 0 ? "" : last ? "  " : "│ ";
  const bar = selected ? "▌" : " ";
  const room = Math.max(4, width - 4 - branch.length);
  return (
    <Clickable flexDirection="column" marginBottom={depth === 0 ? 1 : 0} onClick={onClick}>
      <Text wrap="truncate-end">
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        <Text color={theme.muted}>{branch}</Text>
        {mark}
        {selected ? (
          <Text inverse bold color={theme.brand}>
            {` ${title}`.padEnd(room)}
          </Text>
        ) : (
          <Text bold={depth === 0}> {title}</Text>
        )}
      </Text>
      <Text wrap="truncate-end" {...(selected ? { color: theme.brand } : { dimColor: true })}>
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        <Text color={theme.muted}>{stem}</Text>
        {"  "}
        {subtitle}
      </Text>
      <Text color={theme.accent} wrap="truncate-end">
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        <Text color={theme.muted}>{stem}</Text>
        {"  "}
        {state}
      </Text>
      {depth === 1 && !last ? <Text color={theme.muted}> {stem}</Text> : null}
    </Clickable>
  );
}

/**
 * A sub-agent's work, as it goes: its words and the tools it used. Read
 * only: a sub-agent takes no prompts, the main agent orchestrates it.
 */
export function AgentView({
  agent,
  allOpen = false,
}: {
  readonly agent: SubAgent;
  /** Every group of actions unfolded (ctrl+o); a click flips one. */
  readonly allOpen?: boolean;
}): ReactNode {
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.brand}>
          {agent.title || agent.id}
        </Text>
        <Text dimColor>
          {[agent.model, agent.effort].filter(Boolean).join(" · ") || "no model yet"} · task{" "}
          {agent.id}
        </Text>
        <Text color={theme.accent}>{agent.doing ?? agent.state}</Text>
        {agent.reason && ["review", "failed", "blocked"].includes(agent.state) && (
          <Text color={theme.warning} wrap="wrap">
            {agent.reason.split("\n", 1)[0]}
          </Text>
        )}
      </Box>
      {agent.lines.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {agent.state === "running" ? "Starting…" : "Nothing yet: it has not started."}
          </Text>
        </Box>
      )}
      {foldLines(agent.lines).map((entry) => {
        if ("records" in entry) {
          return (
            <ActionGroup
              key={entry.index}
              records={entry.records}
              open={allOpen !== flipped.has(entry.index)}
              onToggle={() => {
                setFlipped((current) => {
                  const next = new Set(current);
                  if (!next.delete(entry.index)) next.add(entry.index);
                  return next;
                });
              }}
            />
          );
        }
        const { line, index } = entry;
        return line.kind === "text" ? (
          <Box key={index} marginTop={1} paddingLeft={2}>
            <Markdown text={line.text} />
          </Box>
        ) : (
          <Box key={index} paddingLeft={2} flexDirection="column">
            <Text wrap="truncate-end">
              {line.state === "running" ? (
                <Spinner />
              ) : (
                <Text color={line.state === "failed" ? theme.error : theme.success}>
                  {line.state === "failed" ? "✗" : "✓"}
                </Text>
              )}
              <Text color={theme.accent}> {line.label.split("\n", 1)[0]}</Text>
            </Text>
            {line.detail && (
              <Text color={theme.error} wrap="truncate-end">
                {"    "}
                {line.detail}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** A sub-agent's lines with its finished actions in a row gathered into groups. */
function foldLines(
  lines: readonly AgentLine[],
): ({ index: number; line: AgentLine } | { index: number; records: ActionRecord[] })[] {
  const out: ({ index: number; line: AgentLine } | { index: number; records: ActionRecord[] })[] =
    [];
  let group: { index: number; records: ActionRecord[] } | undefined;
  lines.forEach((line, index) => {
    if (line.kind === "tool" && line.state !== "running" && line.action) {
      const record: ActionRecord = {
        action: line.action,
        failed: line.state === "failed",
        ...(line.output !== undefined ? { output: line.output } : {}),
      };
      if (group) group.records.push(record);
      else {
        group = { index, records: [record] };
        out.push(group);
      }
      return;
    }
    group = undefined;
    out.push({ index, line });
  });
  return out;
}
