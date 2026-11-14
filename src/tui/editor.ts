import type { Key } from "ink";

/** What is being typed, and where the cursor is in it. */
export interface EditorState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY: EditorState = { value: "", cursor: 0 };

/** Puts text in at the cursor. */
export function insert(state: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/g, "\n");
  return {
    value: state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor),
    cursor: state.cursor + clean.length,
  };
}

/**
 * One key press on the text; `undefined` when the key is not for editing
 * (Enter, arrows up and down, Tab, Escape: the input decides what they do).
 */
export function edit(state: EditorState, input: string, key: Key): EditorState | undefined {
  const { value, cursor } = state;
  if (key.return || key.upArrow || key.downArrow || key.tab || key.escape) return undefined;
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  if (key.home || (key.ctrl && input === "a")) return { value, cursor: lineStart(value, cursor) };
  if (key.end || (key.ctrl && input === "e")) return { value, cursor: lineEnd(value, cursor) };
  if (key.ctrl && input === "u") return { value: value.slice(cursor), cursor: 0 };
  if (key.ctrl && input === "k") return { value: value.slice(0, cursor), cursor };
  if (key.ctrl && input === "w") {
    const before = value.slice(0, cursor).replace(/\S+\s*$/, "");
    return { value: before + value.slice(cursor), cursor: before.length };
  }
  // Many terminals send Backspace as Delete: both erase to the left.
  if (key.backspace || key.delete) {
    if (cursor === 0) return state;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (key.ctrl || key.meta || input === "") return state;
  return insert(state, input);
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const end = value.indexOf("\n", cursor);
  return end === -1 ? value.length : end;
}
