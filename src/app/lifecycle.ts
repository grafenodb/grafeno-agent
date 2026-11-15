/**
 * The Context Lifecycle Manager's rule: when to renew a conversation.
 *
 * A conversation's context is sent again with every message. While the
 * provider's prompt cache is warm that is cheap; once it has gone cold (a long
 * pause, such as waiting for the plan's window to reset) the next message
 * writes all of it to the cache again, and every message after reads all of
 * it. Measured: 524k–892k tokens written by one call, then ~0.9M read per call
 * (docs/memory-retrieval.md, finding 1). A fresh conversation started from a
 * compact resume costs a small fraction of that.
 *
 * So a conversation is renewed, at the start of a message (never in the
 * middle of one), when:
 *
 * - the cache has gone cold (`idleMinutes` since the last message) and the
 *   context is large (`minContextTokens`); or
 * - the context is nearly full (`maxShare` of the model's window).
 *
 * It is not renewed again until `minTurnsBetween` messages have gone by, so
 * renewing can never loop.
 */

export interface LifecyclePolicy {
  /** Minutes without a message after which the prompt cache counts as cold. Default: 60. */
  readonly idleMinutes: number;
  /** A context at least this large is worth renewing when the cache is cold. Default: 50,000. */
  readonly minContextTokens: number;
  /** A context this full (share of the window) is renewed in any case. Default: 0.8. */
  readonly maxShare: number;
  /** Messages at least between two renewals. Default: 2. */
  readonly minTurnsBetween: number;
}

export const DEFAULT_LIFECYCLE: LifecyclePolicy = {
  idleMinutes: 60,
  minContextTokens: 50_000,
  maxShare: 0.8,
  minTurnsBetween: 2,
};

export interface ConversationState {
  /** When the last message ended; unset before the first. */
  readonly lastActivity?: Date;
  readonly now: Date;
  /** How full the context was at the last request, when the provider said. */
  readonly context?: { readonly used: number; readonly window?: number };
  /** Messages since the conversation started or was last renewed. */
  readonly turnsSinceRenewal: number;
}

export type RenewDecision =
  { readonly renew: false } | { readonly renew: true; readonly reason: string };

export function shouldRenew(
  state: ConversationState,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE,
): RenewDecision {
  const { context } = state;
  if (context === undefined || state.turnsSinceRenewal < policy.minTurnsBetween) {
    return { renew: false };
  }
  const tokens = `${String(Math.round(context.used / 1000))}k tokens`;
  if (context.window !== undefined && context.window > 0) {
    const share = context.used / context.window;
    if (share >= policy.maxShare) {
      return {
        renew: true,
        reason: `the context was ${String(Math.round(share * 100))}% full (${tokens})`,
      };
    }
  }
  if (state.lastActivity !== undefined) {
    const idle = (state.now.getTime() - state.lastActivity.getTime()) / 60_000;
    if (idle >= policy.idleMinutes && context.used >= policy.minContextTokens) {
      return {
        renew: true,
        reason: `${String(Math.round(idle))} minutes without a message, so the prompt cache is cold, and the context held ${tokens}`,
      };
    }
  }
  return { renew: false };
}
