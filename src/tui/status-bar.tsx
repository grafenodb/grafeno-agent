import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Layer } from "./core/input.js";
import { theme } from "./theme.js";

export interface StatusBarProps {
  /** Who has the keys now. */
  readonly focus: Layer | undefined;
  /** The sub-agent on screen, when it is not the main agent. */
  readonly viewing?: string | undefined;
  /** General Auto, or the provider chosen in /connect. */
  readonly auto: boolean;
  /** The agent works without asking (unattended): said loudly. */
  readonly unattended?: boolean;
  /** The permission mode, when it is not "ask" (its label). */
  readonly permissions?: { readonly label: string; readonly skip: boolean } | undefined;
  /** The region with the keys, when the conversation's layer has them. */
  readonly region?: "main" | "left" | "right";
  /** The section of the left column the keyboard is in (MODELS, PROVIDERS, AGENTS). */
  readonly leftSection?: string;
  /** The conversation is maximized for now: the panels stepped aside. */
  readonly maximized?: boolean;
  /** Panels wanted that the window has no room for: they open over the conversation. */
  readonly hidden?: readonly string[];
  /** A narrow window: room for less. */
  readonly narrow: boolean;
  /** The mode and the chat's model: "auto (Opus 5.5)". */
  readonly model?: string;
  /** How many memories the namespace holds, when Grafeno said. */
  readonly memory?: number;
  /** What the narrow window shows on the right (the model and its usage). */
  readonly right?: ReactNode;
}

const FOCUS: Readonly<Record<Layer, string>> = {
  base: "CHAT",
  overlay: "MENU",
  modal: "APPROVAL",
};

/**
 * The bar at the bottom: who has the keys, the mode, what is running
 * without asking, and the keys that work from anywhere. Every state is a
 * word, never a color alone.
 */
export function StatusBar(props: StatusBarProps): ReactNode {
  const panel =
    props.focus === "base" && props.region === "left"
      ? (props.leftSection ?? "AGENTS")
      : props.focus === "base" && props.region === "right"
        ? "PANEL"
        : undefined;
  const focus = props.viewing ? "AGENT" : (panel ?? (props.focus ? FOCUS[props.focus] : "…"));
  const keys = props.narrow
    ? `ctrl+p · ${(props.hidden?.length ?? 0) > 0 ? "ctrl+b panel · " : ""}esc`
    : `Ctrl+P commands · Tab panels · Ctrl+B panel · Ctrl+K model · ${props.maximized ? "Ctrl+F panels back · " : ""}Esc back`;
  return (
    <Box
      paddingX={1}
      justifyContent="space-between"
      flexShrink={0}
      gap={2}
      backgroundColor={theme.panel}
    >
      {/* Narrow: who has the keys and how to move come first; the model on the right gives way. */}
      <Box flexShrink={props.narrow ? 0 : 1} minWidth={10}>
        <Text wrap="truncate-end">
          <Text bold color={props.focus === "modal" ? theme.warning : theme.success}>
            {focus}
          </Text>
          {props.viewing && <Text color={theme.agent}> {props.viewing}</Text>}
          {!props.narrow && props.model !== undefined && (
            <Text>
              {"   "}
              <Text dimColor>model: </Text>
              {props.model}
            </Text>
          )}
          {props.narrow && <Text color={theme.brand}> {props.auto ? "AUTO" : "SPECIFIC"}</Text>}
          {!props.narrow && props.memory !== undefined && (
            <Text>
              {"   "}
              <Text dimColor>memory: </Text>
              {props.memory.toLocaleString()}
            </Text>
          )}
          {!props.narrow && (
            <Text>
              {"   "}
              <Text dimColor>agent: </Text>
              {props.viewing ?? "orchestrator"}
            </Text>
          )}
          {props.unattended ? (
            <Text>
              {"   "}
              <Text inverse bold color={theme.warning}>
                {" UNATTENDED "}
              </Text>
            </Text>
          ) : props.permissions ? (
            <Text color={props.permissions.skip ? theme.warning : theme.accent}>
              {"   "}permissions: {props.permissions.label}
            </Text>
          ) : null}
          {props.maximized && <Text color={theme.focus}>{"   "}maximized</Text>}
          {!props.narrow && !props.maximized && (props.hidden?.length ?? 0) > 0 && (
            <Text dimColor>
              {"   "}no room for the {props.hidden?.join(" and ")} panel: ctrl+b
            </Text>
          )}
          <Text dimColor>
            {"   "}
            {keys}
          </Text>
        </Text>
      </Box>
      {props.right !== undefined && (
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          {props.right}
        </Box>
      )}
    </Box>
  );
}
