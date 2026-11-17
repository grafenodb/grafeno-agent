import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ClickArea } from "../../src/tui/clicks.js";
import { InputArea } from "../../src/tui/core/input.js";
import { ContextMenu } from "../../src/tui/ui/context-menu.js";
import { Dialog } from "../../src/tui/ui/dialog.js";
import { Inspector } from "../../src/tui/ui/inspector.js";
import { Table, type Row } from "../../src/tui/ui/table.js";
import { Tree } from "../../src/tui/ui/tree.js";

const ESC = "\u001B";
const ENTER = "\r";
const DOWN = "\u001B[B";
const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const SHIFT_F10 = "\u001B[21;2~";
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** The interface's input and clicks around a component, as in the app. */
function area(tree: ReactNode) {
  return render(
    <InputArea>
      <ClickArea>{tree}</ClickArea>
    </InputArea>,
  );
}

type App = ReturnType<typeof render>;

/** A mouse press on the first place `text` shows (button 0 left, 2 right). */
function press(app: App, text: string, button = 0): void {
  const lines = (app.lastFrame() ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n");
  const row = lines.findIndex((line) => line.includes(text));
  if (row < 0) throw new Error(`"${text}" is not on the screen:\n${lines.join("\n")}`);
  const column = (lines[row] ?? "").indexOf(text) + 2;
  app.stdin.write(`${ESC}[<${String(button)};${String(column)};${String(row + 1)}M`);
  app.stdin.write(`${ESC}[<${String(button)};${String(column)};${String(row + 1)}m`);
}

async function keys(app: App, ...sequence: string[]): Promise<void> {
  for (const key of sequence) {
    app.stdin.write(key);
    await wait(30);
  }
}

describe("the inspector", () => {
  it("shows what is known, unknown said as such; ↓ then Enter, or a number, does an action", async () => {
    const done: string[] = [];
    let closed = 0;
    const app = area(
      <Inspector
        title="Agent · api"
        fields={[
          { label: "State", value: "running", tone: "agent" },
          { label: "Branch", value: "unknown" },
        ]}
        actions={[
          { id: "view", label: "View its work" },
          { id: "stop", label: "Stop" },
        ]}
        onAction={(id) => done.push(id)}
        onClose={() => {
          closed++;
        }}
      />,
    );
    await wait();
    const screen = app.lastFrame() ?? "";
    expect(screen).toContain("Agent · api");
    expect(screen).toMatch(/Branch\s+unknown/);
    expect(screen).toContain("▸ [1] View its work");
    await keys(app, DOWN, ENTER, "1", ESC);
    expect(done).toEqual(["stop", "view"]);
    expect(closed).toBe(1);
    app.unmount();
  });
});

describe("the dialog", () => {
  it("y confirms, n and Esc do not", async () => {
    const said: string[] = [];
    const app = area(
      <Dialog
        title="Clear the conversation?"
        message="It stays kept."
        onConfirm={() => said.push("yes")}
        onCancel={() => said.push("no")}
      />,
    );
    await wait();
    await keys(app, "n", ESC, "y");
    expect(said).toEqual(["no", "no", "yes"]);
    app.unmount();
  });

  it("what cannot be undone asks for the name, typed in full, before Enter is taken", async () => {
    const said: string[] = [];
    const app = area(
      <Dialog
        title="Delete the namespace mpi?"
        message="Every memory in it goes, for good."
        danger
        typeToConfirm="mpi"
        confirmLabel="Delete"
        onConfirm={() => said.push("deleted")}
        onCancel={() => said.push("kept")}
      />,
    );
    await wait();
    expect(app.lastFrame()).toContain("! Delete the namespace mpi?");
    expect(app.lastFrame()).toContain("Type mpi to confirm");
    // "y" is a letter of the name here, not a yes; Enter waits for the whole name.
    await keys(app, "y", ENTER, "\u007F", "m", "p", ENTER);
    expect(said).toEqual([]);
    await keys(app, "i");
    expect(app.lastFrame()).toContain("mpi ✓");
    await keys(app, ENTER);
    expect(said).toEqual(["deleted"]);
    app.unmount();
  });
});

describe("the context menu", () => {
  it("is a list like the others: a number chooses, Esc closes", async () => {
    const chosen: string[] = [];
    const app = area(
      <ContextMenu
        title="Memory · actions"
        items={[
          { id: "palace", label: "Memory (Grafeno)" },
          { id: "upkeep", label: "Upkeep report" },
        ]}
        onSelect={(id) => chosen.push(id)}
        onClose={() => chosen.push("closed")}
      />,
    );
    await wait();
    await keys(app, "2", ESC);
    expect(chosen).toEqual(["upkeep", "closed"]);
    app.unmount();
  });
});

const rows: Row[] = [
  { id: "r1", cells: { name: "api", state: "completed", attempts: "2" } },
  { id: "r2", cells: { name: "docs", state: "running", attempts: "10" } },
  { id: "r3", cells: { name: "tests", state: "failed", attempts: "1" }, tone: "error" },
];
const columns = [
  { key: "name", title: "Task" },
  { key: "state", title: "State" },
  { key: "attempts", title: "Tries", align: "right" as const },
];

describe("the table", () => {
  it("moves, opens with Enter, and sorts by the column chosen with ←→ (r reverses)", async () => {
    const opened: string[] = [];
    const app = area(
      <Table columns={columns} rows={rows} sortable onOpen={(id) => opened.push(id)} />,
    );
    await wait();
    expect(app.lastFrame()).toMatch(/Task\s+State\s+Tries/);
    await keys(app, DOWN, ENTER);
    expect(opened).toEqual(["r2"]);
    // → sorts by Task, again by State; r reverses it.
    await keys(app, RIGHT, RIGHT);
    expect(app.lastFrame()).toContain("State ▲");
    const order = () =>
      ["api", "docs", "tests"].sort(
        (a, b) => (app.lastFrame() ?? "").indexOf(a) - (app.lastFrame() ?? "").indexOf(b),
      );
    // completed, failed, running.
    expect(order()).toEqual(["api", "tests", "docs"]);
    await keys(app, "r");
    expect(app.lastFrame()).toContain("State ▼");
    expect(order()).toEqual(["docs", "tests", "api"]);
    // Numbers sort as numbers: 1, 2, 10.
    await keys(app, LEFT, "r", "r");
    await keys(app, LEFT);
    expect(app.lastFrame()).toContain("Tries ▲");
    expect(order()).toEqual(["tests", "api", "docs"]);
    app.unmount();
  });

  it("the mouse: a click selects, a double click opens, a right click or Shift+F10 shows the actions", async () => {
    const opened: string[] = [];
    const menus: string[] = [];
    const app = area(
      <Table
        columns={columns}
        rows={rows}
        onOpen={(id) => opened.push(id)}
        onMenu={(id) => menus.push(id)}
      />,
    );
    await wait();
    press(app, "tests");
    await wait();
    expect(app.lastFrame()).toMatch(/▸ tests/);
    press(app, "docs", 2);
    await wait();
    expect(menus).toEqual(["r2"]);
    press(app, "api");
    press(app, "api");
    await wait();
    expect(opened).toEqual(["r1"]);
    await keys(app, SHIFT_F10);
    expect(menus).toEqual(["r2", "r1"]);
    app.unmount();
  });
});

describe("the tree", () => {
  const nodes = [
    {
      id: "run",
      label: "run-1",
      children: [
        { id: "api", label: "api", tone: "success" as const },
        { id: "docs", label: "docs", children: [{ id: "notes", label: "NOTES.md" }] },
      ],
    },
  ];

  it("→ opens and goes in, ← closes and goes up; Enter opens a node's inspector", async () => {
    const opened: string[] = [];
    const app = area(<Tree nodes={nodes} open="none" onOpen={(id) => opened.push(id)} />);
    await wait();
    expect(app.lastFrame()).toContain("+ run-1");
    expect(app.lastFrame()).not.toContain("api");
    await keys(app, RIGHT);
    expect(app.lastFrame()).toContain("− run-1");
    await keys(app, RIGHT, DOWN, RIGHT, RIGHT);
    // docs opened, and in it: NOTES.md selected.
    expect(app.lastFrame()).toMatch(/▸\s+· NOTES\.md/);
    await keys(app, ENTER, LEFT, LEFT);
    expect(opened).toEqual(["notes"]);
    expect(app.lastFrame()).toMatch(/▸\s+\+ docs/);
    expect(app.lastFrame()).not.toContain("NOTES.md");
    app.unmount();
  });

  it("a click on a node with children opens or closes it", async () => {
    const app = area(<Tree nodes={nodes} />);
    await wait();
    expect(app.lastFrame()).toContain("NOTES.md");
    press(app, "docs");
    await wait();
    expect(app.lastFrame()).not.toContain("NOTES.md");
    app.unmount();
  });
});
