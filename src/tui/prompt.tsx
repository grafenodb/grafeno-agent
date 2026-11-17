import { Box, Text, usePaste } from "ink";
import { useHasFocus, useKeys, type Layer } from "./core/input.js";
import { useEffect, useState, type ReactNode } from "react";
import { suggest, type Command } from "./commands.js";
import { edit, EMPTY, insert, type EditorState } from "./editor.js";
import { theme } from "./theme.js";
import { Clickable } from "./clicks.js";

export interface PromptProps {
  /** Whether it takes keys now. */
  readonly active: boolean;
  readonly placeholder?: string;
  /** Called with what was typed when Enter is pressed. */
  readonly onSubmit: (text: string) => void;
  /** Offer the slash commands as one types. Default: true. */
  readonly commands?: boolean;
  /** Show dots instead of what is typed (for a key). */
  readonly mask?: boolean;
  /** What was sent before, oldest first: up and down go through it. */
  readonly history?: readonly string[];
  /** What it starts with. */
  readonly initial?: string;
  /**
   * Its layer in the interface's input: the conversation's prompt is the
   * `base`; one in a menu or dialog (an address, a name) is part of that
   * `overlay`, the default.
   */
  readonly layer?: Layer;
  /** Told what is typed as it changes (kept by whoever shows it again later). */
  readonly onChange?: (text: string) => void;
  /**
   * Whether Enter sends now; when not, what is typed stays and `onHeld` is
   * told (typing goes on while the agent answers). Default: true.
   */
  readonly canSubmit?: boolean;
  readonly onHeld?: (text: string) => void;
}

const MENU = 8;

/** The box one types in, with the slash commands offered as one types. */
export function Prompt(props: PromptProps): ReactNode {
  const [state, setState] = useState<EditorState>(
    props.initial ? insert(EMPTY, props.initial) : EMPTY,
  );
  const [selected, setSelected] = useState(0);
  const [back, setBack] = useState(-1);
  const history = props.history ?? [];
  const menu = props.commands === false ? [] : suggest(state.value);
  const open = menu.length > 0;
  const choice = Math.min(selected, menu.length - 1);

  const layer = props.layer ?? "overlay";
  const focused = useHasFocus(layer, props.active);
  const onChange = props.onChange;
  useEffect(() => {
    onChange?.(state.value);
  }, [state.value, onChange]);

  const submit = (text: string) => {
    if (props.canSubmit === false) {
      props.onHeld?.(text);
      return;
    }
    setState(EMPTY);
    setSelected(0);
    setBack(-1);
    // Said at once: what is sent may close this box before its effect runs.
    onChange?.("");
    props.onSubmit(text);
  };

  usePaste(
    (text) => {
      setState((current) => insert(current, text));
    },
    { isActive: focused },
  );

  useKeys(
    (input, key) => {
      if (key.return) {
        // A line ending in "\" goes on to the next line; so does Shift+Enter.
        if (key.shift || state.value.slice(0, state.cursor).endsWith("\\")) {
          setState((current) =>
            key.shift
              ? insert(current, "\n")
              : insert(
                  {
                    value:
                      current.value.slice(0, current.cursor - 1) +
                      current.value.slice(current.cursor),
                    cursor: current.cursor - 1,
                  },
                  "\n",
                ),
          );
          return;
        }
        const command = open ? menu[choice] : undefined;
        submit(command ? `/${command.name}` : state.value);
        return;
      }
      if (open && (key.upArrow || key.downArrow)) {
        setSelected(
          (key.upArrow ? choice - 1 + menu.length : choice + 1) % Math.max(1, menu.length),
        );
        return;
      }
      if (open && key.tab) {
        const command = menu[choice];
        if (command) setState(insert(EMPTY, `/${command.name}`));
        return;
      }
      if (!open && (key.upArrow || key.downArrow) && history.length > 0) {
        const next = key.upArrow
          ? back === -1
            ? history.length - 1
            : Math.max(0, back - 1)
          : back === -1
            ? -1
            : back + 1;
        if (next === -1 || next >= history.length) {
          setBack(-1);
          setState(EMPTY);
        } else {
          setBack(next);
          setState(insert(EMPTY, history[next] ?? ""));
        }
        return;
      }
      const next = edit(state, input, key);
      if (next) {
        setState(next);
        setSelected(0);
      }
    },
    { isActive: props.active, layer },
  );

  return (
    <Box flexDirection="column">
      {open && (
        <Menu
          commands={menu}
          selected={choice}
          onPick={(command) => {
            submit(`/${command.name}`);
          }}
        />
      )}
      <Box
        borderStyle="round"
        borderColor={props.active ? theme.accent : theme.border}
        paddingX={1}
        flexDirection="row"
      >
        <Text color={theme.accent}>{"› "}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Shown
            state={state}
            active={props.active}
            mask={props.mask === true}
            placeholder={props.placeholder ?? ""}
          />
        </Box>
      </Box>
    </Box>
  );
}

function Menu({
  commands,
  selected,
  onPick,
}: {
  readonly commands: readonly Command[];
  readonly selected: number;
  readonly onPick: (command: Command) => void;
}): ReactNode {
  const start = Math.max(0, Math.min(selected - MENU + 1, commands.length - MENU));
  const visible = commands.slice(start, start + MENU);
  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((command, index) => {
        const on = start + index === selected;
        return (
          <Clickable
            key={command.name}
            onClick={() => {
              onPick(command);
            }}
          >
            <Box width={14}>
              <Text color={on ? theme.accent : theme.brand} bold={on}>
                {on ? "▸ " : "  "}/{command.name}
              </Text>
            </Box>
            <Text dimColor={!on}>{command.description}</Text>
          </Clickable>
        );
      })}
    </Box>
  );
}

/** The text with its cursor, line by line. */
function Shown({
  state,
  active,
  mask,
  placeholder,
}: {
  readonly state: EditorState;
  readonly active: boolean;
  readonly mask: boolean;
  readonly placeholder: string;
}): ReactNode {
  const value = mask ? "•".repeat(state.value.length) : state.value;
  if (value === "") {
    return (
      <Text>
        {active && <Text inverse> </Text>}
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  const lines = value.split("\n");
  let offset = 0;
  return (
    <>
      {lines.map((line, index) => {
        const start = offset;
        offset += line.length + 1;
        const here = active && state.cursor >= start && state.cursor <= start + line.length;
        if (!here) return <Text key={index}>{line === "" ? " " : line}</Text>;
        const at = state.cursor - start;
        return (
          <Text key={index}>
            {line.slice(0, at)}
            <Text inverse>{line[at] ?? " "}</Text>
            {line.slice(at + 1)}
          </Text>
        );
      })}
    </>
  );
}
