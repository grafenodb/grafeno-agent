import type { ReactNode } from "react";
import { Picker, type PickerItem } from "../picker.js";

/** One thing a context menu offers. */
export type MenuItem = PickerItem;

/**
 * What can be done with the thing selected, opened by a right click or
 * Shift+F10 (or the Menu key): the same list as any other in the
 * interface, so it moves, searches by number and closes the same way.
 */
export function ContextMenu(props: {
  readonly title: string;
  readonly items: readonly MenuItem[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Picker
      title={props.title}
      items={props.items}
      rows={Math.min(8, Math.max(1, props.items.length))}
      onSelect={(item) => {
        props.onSelect(item.id);
      }}
      onCancel={props.onClose}
    />
  );
}
