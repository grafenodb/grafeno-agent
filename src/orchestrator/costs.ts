import type { AttemptRecord } from "./metrics.js";
import type { QuotaCost } from "./router.js";

/**
 * What each model, at each effort, was seen to spend of its provider's plan:
 * the share of the provider's fullest usage window one task took. Learned
 * from every recorded attempt across the user's projects and sessions, and
 * from each attempt of the run as it ends, so a model found to eat a large
 * share of a window is kept off simple tasks from then on, in this run and
 * the next sessions, instead of being found out again each time.
 */
export class CostBook {
  readonly #sums = new Map<string, { total: number; n: number }>();

  constructor(
    attempts: readonly Pick<AttemptRecord, "provider" | "model" | "effort" | "quotaShare">[] = [],
  ) {
    for (const attempt of attempts) {
      if (attempt.quotaShare !== undefined) {
        this.add(attempt.provider, attempt.model, attempt.effort, attempt.quotaShare);
      }
    }
  }

  /** One task's measured share of a window. */
  add(provider: string, model: string, effort: string | undefined, share: number): void {
    if (!Number.isFinite(share) || share < 0) return;
    const key = costKey(provider, model, effort);
    const known = this.#sums.get(key) ?? { total: 0, n: 0 };
    this.#sums.set(key, { total: known.total + share, n: known.n + 1 });
  }

  /** What a model and effort of a provider spend per task, when measured. */
  cost(provider: string, model: string, effort: string | undefined): QuotaCost | undefined {
    const known = this.#sums.get(costKey(provider, model, effort));
    return known && known.n > 0 ? { share: known.total / known.n, n: known.n } : undefined;
  }

  /** The cost function the router takes for one provider. */
  costOf(provider: string): (model: string, effort: string | undefined) => QuotaCost | undefined {
    return (model, effort) => this.cost(provider, model, effort);
  }

  /** Every measured arm, most expensive first: for reports. */
  entries(): { arm: string; share: number; n: number }[] {
    return [...this.#sums.entries()]
      .map(([arm, { total, n }]) => ({ arm, share: total / n, n }))
      .sort((a, b) => b.share - a.share);
  }
}

function costKey(provider: string, model: string, effort: string | undefined): string {
  return `${provider}/${model}${effort ? ` · ${effort}` : ""}`;
}

/** Tokens weighted by what they cost a plan: cached reads count a tenth. */
export function weightedTokens(input: number, output: number, cacheRead: number): number {
  return input + output + cacheRead * 0.1;
}

/**
 * The share of a window one attempt spent: how much the provider's window
 * filled while it ran, times its part of the tokens the provider served
 * meanwhile (other attempts on the same provider ran at the same time).
 * Undefined when the window reset in between, or nothing was measured.
 */
export function attemptShare(
  before: number | undefined,
  after: number | undefined,
  own: number,
  servedMeanwhile: number,
): number | undefined {
  if (before === undefined || after === undefined || after < before || own <= 0) return undefined;
  const part = own / Math.max(own, servedMeanwhile);
  return (after - before) * part;
}
