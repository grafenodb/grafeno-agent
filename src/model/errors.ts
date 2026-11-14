export type ModelErrorKind =
  /** The model could not be reached or was overloaded; trying again may work. */
  | "unavailable"
  /** The plan's usage limit is reached: stop and wait for `resetsAt`. Never retried. */
  | "usage_limit"
  /** The model's program is missing or not signed in. */
  | "setup"
  /** The turn took longer than allowed. */
  | "timeout"
  /** The turn was cancelled. */
  | "cancelled"
  /** The conversation cannot go on (its process ended); open a new one. */
  | "lost"
  /** Anything else the model reported. */
  | "failed";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    options?: { cause?: unknown; resetsAt?: Date },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelError";
    this.resetsAt = options?.resetsAt;
  }

  /** When the plan's usage window opens again, for `usage_limit`. */
  readonly resetsAt: Date | undefined;

  /** Whether sending the same message again may work. */
  get retryable(): boolean {
    return this.kind === "unavailable";
  }
}
