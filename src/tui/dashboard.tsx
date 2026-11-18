import { homedir } from "node:os";
import { Box, Text, useApp, useStdin } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppServices } from "../app/services.js";
import { loadProjects, projectAt } from "../projects.js";
import { App, type TabStatus } from "./app.js";
import { ClickArea } from "./clicks.js";
import { InputArea, mouseReports } from "./core/input.js";
import { Picker, type PickerItem } from "./picker.js";
import { theme } from "./theme.js";

/** A session of its own, in a tab: General (outside projects) or a project's. */
export interface Tab {
  readonly key: number;
  /** "General" or the project's name. */
  readonly title: string;
  /** The folder it works in. */
  readonly folder: string;
}

const ESC = String.fromCharCode(27);
/** F2 (home), F3 (the tab before) and F4 (the next), as terminals send them. */
const KEYS: readonly (readonly [RegExp, "home" | "prev" | "next"])[] = [
  [new RegExp(`${ESC}(?:OQ|\\[Q|\\[12~|\\[\\[B)`, "g"), "home"],
  [new RegExp(`${ESC}(?:OR|\\[R|\\[13~|\\[\\[C)`, "g"), "prev"],
  [new RegExp(`${ESC}(?:OS|\\[S|\\[14~|\\[\\[D)`, "g"), "next"],
];

/** The dashboard's keys in a chunk of input, in order. */
export function dashboardKeys(chunk: string): ("home" | "prev" | "next")[] {
  const found: { at: number; key: "home" | "prev" | "next" }[] = [];
  for (const [pattern, key] of KEYS) {
    for (const match of chunk.matchAll(pattern)) found.push({ at: match.index, key });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.key);
}

/** The services of one tab: its session and its runs in the tab's folder. */
export function servicesIn(services: AppServices, folder: string): AppServices {
  return {
    ...services,
    start: (extra) => services.start({ ...extra, cwd: folder }),
    orchestrator: (extra, auto) => services.orchestrator(extra, auto, folder),
  };
}

/** Where a General session works: the folder it was started in, unless that is a project's. */
export function generalFolder(launched: string, inProject: boolean): string {
  return inProject ? homedir() : launched;
}

/** A tab's word on the bar and the home page: what it is doing. */
function stateOf(status: TabStatus | undefined): { mark: string; color: string; said: string } {
  if (!status || status.starting) return { mark: "◌", color: theme.muted, said: "connecting" };
  if (status.busy !== undefined) return { mark: "●", color: theme.warning, said: status.busy };
  return { mark: "○", color: theme.success, said: "idle" };
}

/**
 * The window with several sessions at once: each in a tab of its own, a
 * General one or a project's, with its own model and memory; the ones not
 * on screen go on working. The home page (F2) shows them all and opens new
 * ones; F3 and F4 go to the tab before and the next; /exit closes a tab, and
 * the program ends with the last one.
 */
export function Dashboard(props: {
  readonly services: AppServices;
  /** The folder the program was started in. Default: the process's. */
  readonly folder?: string;
}): ReactNode {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const launched = props.folder ?? process.cwd();
  const here = useMemo(() => projectAt(launched), [launched]);
  const nextKey = useRef(1);
  const [tabs, setTabs] = useState<readonly Tab[]>(() => [
    { key: 0, title: here?.name ?? "General", folder: here?.path ?? launched },
  ]);
  // The tab on screen, or the home page (undefined).
  const [current, setCurrent] = useState<number | undefined>(0);
  const [statuses, setStatuses] = useState<ReadonlyMap<number, TabStatus>>(new Map());

  const open = useCallback((title: string, folder: string) => {
    const key = nextKey.current++;
    setTabs((all) => [...all, { key, title, folder }]);
    setCurrent(key);
  }, []);

  // Each tab's own callbacks, made once: a new one each time would loop its effects.
  const reporters = useRef(new Map<number, (status: TabStatus) => void>());
  const reporter = (key: number) => {
    let found = reporters.current.get(key);
    if (!found) {
      found = (status) => {
        setStatuses((all) => {
          const was = all.get(key);
          if (
            was !== undefined &&
            was.busy === status.busy &&
            was.model === status.model &&
            was.starting === status.starting
          ) {
            return all;
          }
          return new Map(all).set(key, status);
        });
      };
      reporters.current.set(key, found);
    }
    return found;
  };
  const close = (key: number) => {
    reporters.current.delete(key);
    setTabs((all) => {
      const left = all.filter((t) => t.key !== key);
      if (left.length === 0) exit();
      return left;
    });
    setCurrent((now) => (now === key ? undefined : now));
  };

  // The bar's tabs, where each starts and ends on the first row (for clicks).
  const labels = tabs.map((t) => {
    const s = stateOf(statuses.get(t.key));
    return { key: t.key, text: ` ${s.mark} ${t.title} `, color: s.color };
  });
  const homeText = " ⌂ Home ";
  let x = homeText.length + 1;
  const spans = labels.map((l) => {
    const span = { key: l.key, from: x, to: x + l.text.length };
    x = span.to + 1;
    return span;
  });

  // F2, F3, F4 and clicks on the bar: read before any tab sees them.
  const state = useRef({ tabs, current, spans });
  state.current = { tabs, current, spans };
  useEffect(() => {
    const listener = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const key of dashboardKeys(text)) {
        const { tabs: all, current: now } = state.current;
        if (key === "home") {
          setCurrent(undefined);
          continue;
        }
        if (all.length === 0) continue;
        const at = all.findIndex((t) => t.key === now);
        const step = key === "next" ? 1 : -1;
        const next =
          at === -1 ? (step === 1 ? 0 : all.length - 1) : (at + step + all.length) % all.length;
        setCurrent(all[next]?.key);
      }
      for (const event of mouseReports(text)) {
        if (event.kind !== "press" || event.y !== 0) continue;
        if (event.x < homeText.length) {
          setCurrent(undefined);
          continue;
        }
        const hit = state.current.spans.find((s) => event.x >= s.from && event.x < s.to);
        if (hit) setCurrent(hit.key);
      }
    };
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin]);

  const home = current === undefined;
  const projects = useMemo(() => {
    try {
      return loadProjects();
    } catch {
      return [];
    }
    // Read again each time the home page opens: a project added in a tab shows.
  }, [home]);
  const items: PickerItem[] = [
    ...tabs.map((t) => {
      const s = stateOf(statuses.get(t.key));
      const model = statuses.get(t.key)?.model;
      return {
        id: `tab:${String(t.key)}`,
        label: `${s.mark} ${t.title} · ${s.said}`,
        hint: model ?? t.folder,
      };
    }),
    {
      id: "new:general",
      label: "+ New session · General",
      hint: "outside any project, with the general memory",
    },
    ...projects.map((p) => ({
      id: `new:${p.name}`,
      label: `+ New session · ${p.name}`,
      hint: `${p.path} · its own memory`,
    })),
  ];

  return (
    <Box flexDirection="column">
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          <Text {...(home ? { inverse: true, color: theme.brand } : { color: theme.brand })}>
            {homeText}
          </Text>{" "}
          {labels.map((l) => (
            <Text key={l.key}>
              <Text {...(l.key === current ? { inverse: true, bold: true } : {})} color={l.color}>
                {l.text}
              </Text>{" "}
            </Text>
          ))}
          <Text dimColor> F2 home · F3 F4 tabs</Text>
        </Text>
      </Box>
      {home && (
        <InputArea>
          <ClickArea>
            <Box flexDirection="column" paddingX={1}>
              <Text dimColor wrap="wrap">
                Each session works on its own, with its own model and memory: leave one running and
                open another. Enter goes to a session or opens a new one; esc back.
              </Text>
              <Picker
                title={`Sessions · ${String(tabs.length)} open`}
                items={items}
                onSelect={(item) => {
                  if (item.id.startsWith("tab:")) {
                    setCurrent(Number(item.id.slice(4)));
                  } else if (item.id === "new:general") {
                    open("General", generalFolder(launched, here !== undefined));
                  } else {
                    const project = projects.find((p) => `new:${p.name}` === item.id);
                    if (project) open(project.name, project.path);
                  }
                }}
                onCancel={() => {
                  setCurrent(tabs.at(-1)?.key);
                }}
              />
            </Box>
          </ClickArea>
        </InputArea>
      )}
      {tabs.map((t) => (
        <Box key={t.key} display={t.key === current ? "flex" : "none"} flexDirection="column">
          <App
            services={servicesIn(props.services, t.folder)}
            active={t.key === current}
            reserve={1}
            onExit={() => {
              close(t.key);
            }}
            onStatus={reporter(t.key)}
            onOpenProject={(project) => {
              open(project.name, project.path);
            }}
          />
        </Box>
      ))}
    </Box>
  );
}
