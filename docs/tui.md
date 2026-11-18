# The terminal interface

How the interface is built, for whoever adds to it. It is Ink (React for
the terminal); nothing here replaces it. The core of the agent (sessions,
memory, providers, orchestration, permissions) is reached only through
the services and APIs it already has: the interface shows and asks, it
does not decide.

```text
src/tui/
├─ core/            how input, focus, actions and layout work
│  ├─ input.tsx     one reader of the terminal: keys, mouse, Shift+F10
│  ├─ actions.ts    each command and key, named once
│  └─ layout.ts     where each region goes, from what each needs
├─ ui/              components every view shares
│  inspector · context-menu · dialog · table · tree
├─ views/           one per thing to look at, over the conversation
│  runs · providers · models · memory
├─ adapters/        what the core recorded, as rows and fields
│  runs · providers          (memory: src/app/memory-admin.ts)
├─ shell.tsx        the frame: header, menu, left, main, right, status
├─ status-bar.tsx   who has the keys, the mode, the keys that work anywhere
└─ app.tsx          the conversation, and what opens over it
```

## Input and focus

`InputArea` (core/input.tsx) is the only place that reads the terminal:
one Ink `useInput` for keys, one listener for mouse reports. Handlers
register by **layer**:

| Layer     | What                                   |
| --------- | -------------------------------------- |
| `modal`   | an approval: over everything           |
| `overlay` | a menu, a dialog, a view, an inspector |
| `base`    | the conversation, or a panel beside it |

A key goes to the active handlers of the highest layer on screen, then to
the global shortcuts (`useGlobalKeys`), which are told which layer had it.
The layers below hear nothing: a key typed in a menu never reaches the
prompt behind it. Within a layer every active handler hears the key (a
panel and the list in it share it); a component that is not the one in
charge switches itself off (`isActive`).

- `useKeys(handler, { layer, isActive })`: keys.
- `useMenuKey(handler, …)`: Shift+F10 or the Menu key (read from the raw
  input: Ink hands Shift+F10 over as an empty key and drops the Menu key).
- `useMouse`, `useWheel`: the wheel and the buttons, in the layer with the
  focus; clicks reach every `Clickable` (the innermost one under the
  pointer answers).
- `useFocusLayer()`, `useHasFocus(layer)`: who has the keys now.

Handlers register in a layout effect, in the commit that draws them: a
passive effect may run after the next key, and a list that just appeared
would lose the Enter pressed on it.

Within the conversation's layer, `region` (app.tsx) says which part has
the keys: the conversation, the side panel or the agents panel; Tab and
Shift+Tab move it, Esc brings it back. What opens over it (a menu, an
inspector, a view) keeps the region and the row it came from, so closing
it gives the keys back exactly where they were.

Outside an `InputArea` the hooks behave as Ink's own, so a component can
be tested on its own.

## Actions

A command typed with `/`, a menu button, a key and the command palette
(Ctrl+P) name the same action (`command.<name>`, `view.…`, `agents.…`), run
by `runAction` in app.tsx. A new action goes in `VIEW_ACTIONS`
(core/actions.ts) with its title, hint and key; the palette lists it.

## Layout

`computeLayout` (core/layout.ts) gives each region its width from the
narrowest each can be: the conversation 60 columns, the side panel 30 to
56, the agents panel 24 to 44. A panel shows only when it fits beside the
conversation at its narrowest; the conversation comes first, the side
panel second. Fewer than 18 rows: the conversation alone. The result is
`wide`, `standard` or `compact`; in compact, Ctrl+B opens the side panel
over the conversation (`PanelOverlay`). What the person chose (panels on
or off, their widths) is kept in `AGENT_TUI_LAYOUT`; Ctrl+F (maximized) is
not.

## Components

| Component     | Keys                                                     | Mouse                                    |
| ------------- | -------------------------------------------------------- | ---------------------------------------- |
| `Table`       | ↑↓ PgUp PgDn Home End, Enter open, ←→ sort, r reverse    | click select, double open, right actions |
| `Tree`        | ↑↓, → open or go in, ← close or go up, Enter open        | click select (and open/close), same rest |
| `Inspector`   | ↑↓ or ←→ an action, Enter or a number does it, Esc close | click an action                          |
| `ContextMenu` | the Picker's: ↑↓, a number, Enter, Esc                   | click                                    |
| `Dialog`      | y / n, Esc; a name typed in full when asked, then Enter  | click either answer                      |

Shift+F10 (or the Menu key) shows a row's actions wherever a right click
does. Every component works with the keyboard alone.

## Views and adapters

A view is a component opened over the conversation (`mode === "view"`),
with the same keys: ↑↓, Enter to inspect, Esc to go back a step and close
from its first. It gets what it shows from an adapter, which reads what
the core recorded and says "unknown" for what it did not:

- `adapters/runs.ts`: a project's runs and tasks from the runs' store
  (tool calls are not kept there, and the inspector says so);
- `adapters/providers.ts`: a connection's state from what it answered
  (available, connected but held back by billing, configured,
  unavailable, error), never from a setting alone;
- `src/app/memory-admin.ts`: the memory through Grafeno's client (search,
  facts, contradictions, namespaces; delete, and empty as delete and
  create again).

A new view: an adapter (if what it shows is not there yet), a component in
`views/` built from the `ui/` components, a command or an action that sets
`view`, and a test with a fake adapter.

## Rendering

The whole screen re-renders on every change. What streams in is drawn at
most every 40 ms (the terminal shows at most 30 frames a second); a long
answer is drawn a few dozen times, not once per fragment. Colors come from
`theme.ts`, by what they mean (focus, memory, states); a mark or a word
always says it too. `NO_COLOR` turns colors off (the terminal library
reads `FORCE_COLOR`, so the CLI tells it before it loads), and a terminal
with fewer colors gets the nearest ones.
