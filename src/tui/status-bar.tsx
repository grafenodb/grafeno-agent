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
  /** The conversation is maximized for now: the panels stepped aside. */
  readonly maximized?: boolean;
  /** Panels wanted that the window has no room for: they open over the conversation. */
  readonly hidden?: readonly string[];
  /** A narrow window: room for less. */
  readonly narrow: boolean;
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
  const focus = props.viewing ? "AGENT" : props.focus ? FOCUS[props.focus] : "…";
  const keys = props.narrow
    ? "ctrl+p commands · esc back"
    : `ctrl+p commands · ctrl+b panels · ctrl+f ${props.maximized ? "panels back" : "focus"} · pgup/pgdn scroll · esc back or stop`;
  return (
    <Box paddingX={1} justifyContent="space-between" flexShrink={0} gap={2}>
      <Box flexShrink={1} minWidth={10}>
        <Text wrap="truncate-end">
          <Text inverse bold color={props.focus === "modal" ? theme.warning : theme.focus}>
            {` ${focus} `}
          </Text>
          {props.viewing && <Text color={theme.agent}> {props.viewing}</Text>}
          <Text dimColor> │ </Text>
          <Text color={theme.brand}>{props.auto ? "AUTO" : "SPECIFIC"}</Text>
          {props.unattended ? (
            <>
              <Text dimColor> │ </Text>
              <Text inverse bold color={theme.warning}>
                {" UNATTENDED "}
              </Text>
            </>
          ) : props.permissions ? (
            <>
              <Text dimColor> │ </Text>
              <Text color={props.permissions.skip ? theme.warning : theme.accent}>
                {`permissions: ${props.permissions.label}`}
              </Text>
            </>
          ) : null}
          {props.maximized && <Text color={theme.focus}> │ maximized</Text>}
          {!props.maximized && (props.hidden?.length ?? 0) > 0 && (
            <Text dimColor> │ no room for the {props.hidden?.join(" and ")} panel: ctrl+b</Text>
          )}
          <Text dimColor> │ {keys}</Text>
        </Text>
      </Box>
      {props.right}
    </Box>
  );
}
