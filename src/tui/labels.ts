import type { AgentSession } from "../app/session.js";
import type { ModelOption } from "../providers/types.js";

const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** An effort as people read it: `xhigh` → "Extra high". */
export function effortLabel(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  return EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * The exact name of the model in use: the one that answered last, else the
 * one asked for, as the provider names it.
 */
export function modelName(session: AgentSession, models: readonly ModelOption[]): string {
  if (session.modelId !== undefined) return session.provider.modelName(session.modelId);
  const option = models.find((m) => m.id === session.model);
  if (option) return option.name;
  return session.model === "default" ? "Default model" : session.model;
}

/** "Opus 5.5 · Medium". */
export function modelLine(session: AgentSession, models: readonly ModelOption[]): string {
  const effort = effortLabel(session.effort);
  return effort === undefined
    ? modelName(session, models)
    : `${modelName(session, models)} · ${effort}`;
}

/** 1234 → "1.2k". */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** A bar of `width` cells, `used` from 0 to 1 of it filled. */
export function bar(used: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(0, Math.min(width, Math.round(used * width)));
  return { filled: "█".repeat(cells), empty: "░".repeat(width - cells) };
}

/** "Nov 14, 1:19pm (America/Guayaquil)" → "Nov 14, 1:19pm". */
export function shortResets(resets: string | undefined): string | undefined {
  return resets?.replace(/\s*\([^)]*\)\s*$/, "");
}

/** A path, its start cut when it is longer than `width`: "…\Personal\grafeno-agent". */
export function shortPath(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

export function ago(at: Date | string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(at).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h ago`;
  return `${String(Math.floor(seconds / 86_400))} d ago`;
}

/** The color for how much of a limit is used. */
export function usageTone(used: number): "success" | "warning" | "error" {
  return used >= 0.9 ? "error" : used >= 0.75 ? "warning" : "success";
}
