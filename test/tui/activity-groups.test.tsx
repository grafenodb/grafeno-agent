import { Box, Text, type DOMElement } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useRef } from "react";
import { describe, expect, it } from "vitest";
import { describeResult } from "../../src/orchestrator/result.js";
import type { RunEvent, TaskRecord } from "../../src/orchestrator/store.js";
import {
  ActionGroup,
  actionOutput,
  groupSummary,
  type ActionRecord,
} from "../../src/tui/activity.js";
import { rectOf } from "../../src/tui/clicks.js";

const record = (verb: string, target: string, failed = false, output?: string): ActionRecord => ({
  action: { verb, target },
  failed,
  ...(output === undefined ? {} : { output }),
});

describe("groups of actions", () => {
  it("say how many of each, as a person would", () => {
    expect(
      groupSummary([
        record("Read", "a"),
        record("Read", "b"),
        record("Edit", "a"),
        record("Run", "npm test"),
        record("Run", "npm run lint"),
      ]),
    ).toBe("Read 2 files, edited a file, ran 2 commands");
    expect(groupSummary([record("Web search", "q")])).toBe("Searched the web once");
    expect(groupSummary([record("Recall", "x"), record("Recall", "y")])).toBe("Recall ×2");
  });

  it("keep what each did: a change as - and + lines, a command's output, an error", () => {
    expect(actionOutput("edit_file", { old_text: "a\nb", new_text: "c" }, "Edited.", false)).toBe(
      "- a\n- b\n+ c",
    );
    const long = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join("\n");
    const out = actionOutput("run_command", { command: "x" }, long, false).split("\n");
    expect(out).toHaveLength(13);
    expect(out.at(-1)).toBe("… 18 more lines");
    expect(actionOutput("read_file", {}, long, false).split("\n")).toHaveLength(5);
    expect(actionOutput("edit_file", {}, "Not allowed: outside", true)).toBe(
      "Not allowed: outside",
    );
  });

  it("show one line folded, and a line per action unfolded (its output on a click)", () => {
    const records = [
      record("Read", "src/a.ts", false, "File src/a.ts"),
      record("Edit", "src/a.ts", false, "- old\n+ new"),
      record("Run", "npm test", true, "exit 1: 2 failed"),
    ];
    const folded = render(<ActionGroup records={records} open={false} />);
    const line = folded.lastFrame() ?? "";
    expect(line).toContain("Read a file, edited a file, ran a command · 1 failed ▸");
    // Folded: in its frame, its title and one line, whatever the number of actions.
    expect(line.split("\n").filter((l) => /[A-Za-z]/.test(l))).toHaveLength(2);
    folded.unmount();
    const open = render(<ActionGroup records={records} open />);
    const shown = open.lastFrame() ?? "";
    expect(shown).toContain("▾");
    expect(shown).toContain("Edit");
    expect(shown).toContain("npm test");
    // A line per action: the outputs wait for a click on the action.
    expect(shown).not.toContain("+ new");
    expect(shown).toContain("click an action for its output");
    open.unmount();
    // One action alone reads as itself.
    const one = render(<ActionGroup records={[record("Run", "npm test")]} open={false} />);
    expect(one.lastFrame()).toContain("Run npm test ▸");
    one.unmount();
  });
});

describe("where a click lands in a scrolled conversation", () => {
  it("what is scrolled up moves up, and what is scrolled out of view cannot be clicked", () => {
    const rects: Record<string, ReturnType<typeof rectOf>> = {};
    function Probe({ name }: { readonly name: string }) {
      const ref = useRef<DOMElement>(null);
      useEffect(() => {
        if (ref.current) rects[name] = rectOf(ref.current);
      });
      return (
        <Box ref={ref}>
          <Text>{name}</Text>
        </Box>
      );
    }
    const app = render(
      <Box flexDirection="column" height={3} overflow="hidden" contentOffsetY={4}>
        <Box flexDirection="column" flexShrink={0}>
          {["l0", "l1", "l2", "l3", "l4", "l5"].map((n) => (
            <Probe key={n} name={n} />
          ))}
        </Box>
      </Box>,
    );
    expect(app.lastFrame()).toContain("l4");
    expect(rects.l4).toMatchObject({ y: 0, height: 1 });
    expect(rects.l5).toMatchObject({ y: 1 });
    expect(rects.l0).toBeUndefined();
    app.unmount();
  });
});

describe("the result of a run", () => {
  const task = (id: string, title: string, state: TaskRecord["state"], reason?: string) =>
    ({
      runId: "r",
      id,
      spec: { title },
      state,
      attempts: 1,
      updated: "",
      ...(reason ? { reason } : {}),
    }) as unknown as TaskRecord;
  const ended = (taskId: string, summary: string): RunEvent => ({
    seq: 1,
    runId: "r",
    taskId,
    at: "",
    kind: "attempt_ended",
    data: { status: "completed", summary },
  });

  it("says how many tasks were done, and what each did or why not", () => {
    const done = describeResult(
      [task("a", "Write alpha", "completed"), task("b", "Write beta", "completed")],
      [ended("a", "## Done\nAdded alpha.txt with its test."), ended("b", "Added beta.txt.")],
      "completed",
    );
    expect(done).toEqual({
      ok: true,
      headline: "Done: 2 of 2 tasks done.",
      tasks: ["✓ Write alpha — Done", "✓ Write beta — Added beta.txt."],
    });
    const stopped = describeResult(
      [task("a", "Write alpha", "completed"), task("b", "Write beta", "failed", "tests fail")],
      [ended("a", "Added alpha.txt.")],
      "failed",
    );
    expect(stopped.ok).toBe(false);
    expect(stopped.headline).toBe("Stopped: 1 of 2 tasks done, 1 failed.");
    expect(stopped.tasks[1]).toBe("✗ Write beta — tests fail");
  });
});
