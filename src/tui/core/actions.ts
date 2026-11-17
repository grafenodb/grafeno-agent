import type { Command } from "../commands.js";
import type { PickerItem } from "../picker.js";

/**
 * What the interface can do, each once: a menu button, a key, a command
 * typed with "/" and the command palette all name the same action, so they
 * do the same thing. Its effect is the interface's (`runAction`); this is
 * what it is called and how it is reached.
 */
export interface ActionSpec {
  /** `command.<name>` for a slash command; `view.…`, `agents.…` for the rest. */
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  /** Its key, when it has one ("ctrl+b"). */
  readonly keys?: string;
}

/** The actions that are not slash commands: what the interface's keys do. */
export const VIEW_ACTIONS: readonly ActionSpec[] = [
  { id: "view.sidebar", title: "Side panel", hint: "show or hide it", keys: "ctrl+b" },
  {
    id: "view.fold",
    title: "Actions in the chat",
    hint: "open or fold all of them",
    keys: "ctrl+o",
  },
  {
    id: "agents.next",
    title: "Next agent",
    hint: "the main agent, then each sub-agent",
    keys: "ctrl+n",
  },
];

/** The action of a slash command. */
export function commandAction(name: string): string {
  return `command.${name}`;
}

/** Each slash command as an action. */
export function commandActions(commands: readonly Command[]): ActionSpec[] {
  return commands.map((c) => ({
    id: commandAction(c.name),
    title: `/${c.name}`,
    hint: c.description,
  }));
}

/** The command palette's rows: every action, searchable by its title and hint. */
export function paletteItems(actions: readonly ActionSpec[]): PickerItem[] {
  return actions.map((a) => ({
    id: a.id,
    label: a.keys ? `${a.title}  (${a.keys})` : a.title,
    ...(a.hint === undefined ? {} : { hint: a.hint }),
  }));
}
