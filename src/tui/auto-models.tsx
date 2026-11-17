import { Box, Text } from "ink";
import { useKeys } from "./core/input.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWheel } from "./mouse.js";
import { matchesQuery, useListRows, windowStart } from "./picker.js";
import type { ModelOption, Provider } from "../providers/types.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";
import { Clickable } from "./clicks.js";

export interface AutoModelsPanelProps {
  readonly provider: Provider;
  /** The models chosen now; empty: Auto (all of them). */
  readonly chosen: readonly string[];
  /** With the models chosen (empty: Auto), or nothing on Esc. */
  readonly onDone: (models: string[] | undefined) => void;
}

/**
 * Which of a provider's models General Auto may use: Auto (every model,
 * chosen by the task and by what each was seen to spend), or the ones the
 * person marks. Chosen models are used because the person wants them: the
 * router still sends hard tasks to the strongest of them and simple ones to
 * the lightest, but never swaps them for others by usage or cost.
 */
export function AutoModelsPanel(props: AutoModelsPanelProps): ReactNode {
  const [models, setModels] = useState<readonly ModelOption[] | undefined>(undefined);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set(props.chosen));
  const [at, setAt] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void props.provider
      .models()
      .then((found) => {
        if (live) setModels(found.filter((m) => m.id !== "default"));
      })
      .catch(() => {
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
  }, [props.provider]);

  // What was typed narrows the list (an API may offer hundreds of models).
  const shown = useMemo(
    () =>
      (models ?? []).filter((m) =>
        matchesQuery({ id: m.id, label: m.name, ...(m.hint ? { hint: m.hint } : {}) }, query),
      ),
    [models, query],
  );
  const rows = shown.length + 1;
  const visible = useListRows(undefined, 14, 16);
  const start = windowStart(Math.max(0, at - 1), visible, shown.length);
  useWheel(
    useCallback(
      (direction: number) => {
        setAt((a) => Math.max(0, Math.min(rows - 1, a - direction)));
      },
      [rows],
    ),
  );
  const toggle = (id: string) => {
    setMarked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const save = () => {
    props.onDone(models?.filter((m) => marked.has(m.id)).map((m) => m.id) ?? []);
  };
  useKeys((input, key) => {
    if (key.escape) {
      if (query !== "") {
        setQuery("");
        setAt(0);
      } else props.onDone(undefined);
    } else if (key.upArrow) setAt((a) => Math.max(0, a - 1));
    else if (key.downArrow) setAt((a) => Math.min(rows - 1, a + 1));
    else if (key.pageUp) setAt((a) => Math.max(0, a - visible));
    else if (key.pageDown) setAt((a) => Math.min(rows - 1, a + visible));
    else if (input === " ") {
      if (at === 0) setMarked(new Set());
      else {
        const id = shown[at - 1]?.id;
        if (id !== undefined) toggle(id);
      }
    } else if (key.return) save();
    else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setAt(0);
    } else if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
      setAt(1);
    }
  });

  const auto = marked.size === 0;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>
          {props.provider.name} · models in Auto
        </Text>
        <Text dimColor>
          {" "}
          · {String(shown.length)}
          {query === "" ? "" : ` of ${String(models?.length ?? 0)}`} · search:{" "}
        </Text>
        <Text color={theme.accent}>{query === "" ? "type a name" : query}</Text>
      </Text>
      {models === undefined ? (
        <Box>
          <Spinner />
          <Text dimColor> asking for its models…</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Clickable
            onClick={() => {
              setAt(0);
              setMarked(new Set());
            }}
          >
            <Text {...(at === 0 ? { color: theme.selected } : {})} bold={at === 0}>
              {at === 0 ? "▸ " : "  "}
              {auto ? "[✓]" : "[ ]"} Auto
              <Text dimColor> every model, chosen by the task and by what each spends</Text>
            </Text>
          </Clickable>
          {start > 0 && <Text dimColor> ↑ {String(start)} more</Text>}
          {shown.slice(start, start + visible).map((model, offset) => {
            const index = start + offset;
            const on = index + 1 === at;
            return (
              <Clickable
                key={model.id}
                onClick={() => {
                  setAt(index + 1);
                  toggle(model.id);
                }}
              >
                <Text {...(on ? { color: theme.selected } : {})} bold={on}>
                  {on ? "▸ " : "  "}
                  {marked.has(model.id) ? "[✓]" : "[ ]"} {model.name}
                  {model.hint ? <Text dimColor> {model.hint}</Text> : null}
                </Text>
              </Clickable>
            );
          })}
          {shown.length - start - visible > 0 && (
            <Text dimColor> ↓ {String(shown.length - start - visible)} more</Text>
          )}
          {models.length > 0 && shown.length === 0 && (
            <Text color={theme.warning}>No model matches “{query}”. esc clears the search.</Text>
          )}
          {models.length === 0 && (
            <Text color={theme.warning}>
              It did not list its models now: Auto uses all of them.
            </Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          Chosen models are used as you chose them: the hardest tasks go to the strongest, simple
          ones to the lightest, never swapped by usage or cost.
        </Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>type to search · space or click mark ·</Text>
        <Clickable onClick={save}>
          <Text color={theme.accent} underline>
            enter save
          </Text>
        </Clickable>
        <Clickable
          onClick={() => {
            props.onDone(undefined);
          }}
        >
          <Text dimColor underline>
            esc back
          </Text>
        </Clickable>
      </Box>
    </Box>
  );
}
