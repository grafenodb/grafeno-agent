import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { SubAgent } from "./agents.js";
import { Markdown } from "./markdown.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

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
}: {
  readonly width: number;
  readonly main: { readonly model: string; readonly doing: string; readonly busy: boolean };
  readonly agents: readonly SubAgent[];
  /** The key of the agent shown, or undefined for the main one. */
  readonly viewing: string | undefined;
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
          name="Main"
          detail={main.model}
          doing={main.doing}
          width={width}
        />
        {agents.map((agent) => {
          const look = MARK[agent.state];
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
              name={agent.id}
              detail={[agent.model, agent.effort].filter(Boolean).join(" · ") || agent.title}
              doing={agent.doing ?? agent.state}
              width={width}
            />
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          ctrl+n / ctrl+p switch (▌ the one on screen) · /agents picks one
        </Text>
      </Box>
    </Box>
  );
}

function Entry({
  selected,
  mark,
  name,
  detail,
  doing,
  width,
}: {
  readonly selected: boolean;
  readonly mark: ReactNode;
  readonly name: string;
  readonly detail: string;
  readonly doing: string;
  readonly width: number;
}): ReactNode {
  // The one being viewed is drawn as a selection: a bar on its left and its
  // name on an inverted band, so it is plain which agent is on screen.
  const bar = selected ? "▌" : " ";
  const label = ` ${name}`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        {mark}
        {selected ? (
          <Text inverse bold color={theme.brand}>
            {label.padEnd(Math.max(label.length, width - 4))}
          </Text>
        ) : (
          <Text>{label}</Text>
        )}
      </Text>
      <Text wrap="truncate-end" {...(selected ? { color: theme.brand } : { dimColor: true })}>
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        {"   "}
        {detail}
      </Text>
      <Text color={theme.accent} wrap="truncate-end">
        <Text color={selected ? theme.brand : theme.muted}>{bar}</Text>
        {"   "}
        {doing}
      </Text>
    </Box>
  );
}

/**
 * A sub-agent's work, as it goes: its words and the tools it used. Read
 * only: a sub-agent takes no prompts, the main agent orchestrates it.
 */
export function AgentView({ agent }: { readonly agent: SubAgent }): ReactNode {
  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold color={theme.brand}>
            {agent.id}
          </Text>
          <Text dimColor>
            {" "}
            · {agent.title}
            {agent.model ? ` · ${agent.model}` : ""}
            {agent.effort ? ` · ${agent.effort}` : ""} · {agent.state}
          </Text>
        </Text>
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
      {agent.lines.map((line, index) =>
        line.kind === "text" ? (
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
        ),
      )}
    </Box>
  );
}
