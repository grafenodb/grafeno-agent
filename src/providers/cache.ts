import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderAuth, ProviderStatus, ProviderUsage } from "./types.js";

/** How long a provider's answers are reused before it is asked again. */
export interface CacheAges {
  /** Its status (installed, signed in, billing). Default: 60 seconds. */
  readonly statusMs?: number;
  /** Its plan's usage. Default: 60 seconds. */
  readonly usageMs?: number;
}

interface Entry {
  readonly at: number;
  readonly value: unknown;
}

/**
 * What providers answered lately, kept for a short while: in memory, and in
 * a small file of the data folder so that other processes of the agent (a
 * second terminal, a background run) reuse it too. It holds statuses and
 * usage, never a credential.
 */
export class ProviderStateCache {
  #entries: Record<string, Entry> | undefined;

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A value no older than `maxAgeMs`, with when it was read. */
  get(key: string, maxAgeMs: number): Entry | undefined {
    const entry = this.#read()[key];
    return entry && this.now() - entry.at < maxAgeMs ? entry : undefined;
  }

  set(key: string, value: unknown): void {
    this.#entries = { ...this.#read(), [key]: { at: this.now(), value } };
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${String(process.pid)}.tmp`;
      writeFileSync(temp, JSON.stringify(this.#entries));
      renameSync(temp, this.file);
    } catch {
      // A cache that cannot be written is only asked again.
    }
  }

  #read(): Record<string, Entry> {
    // The file is read each time: another process may have asked meanwhile.
    if (this.file) {
      try {
        this.#entries = {
          ...this.#entries,
          ...(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Entry>),
        };
      } catch {
        // No file yet, or one being written: what this process knows.
      }
    }
    return this.#entries ?? {};
  }
}

/**
 * A provider's authentication part, its answers reused for a short while:
 * asking a provider for its status or its plan's usage starts its program
 * and takes seconds, while a reading of a minute ago is as good for what it
 * is used for. Calls made at once share one question. `usage({ fresh })`
 * asks anew. A failed answer is not kept.
 */
export class CachedAuth implements ProviderAuth {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly id: string,
    private readonly inner: ProviderAuth,
    private readonly cache: ProviderStateCache,
    private readonly ages: CacheAges = {},
  ) {}

  get method() {
    return this.inner.method;
  }

  get signIn() {
    return this.inner.signIn;
  }

  async status(): Promise<ProviderStatus> {
    const key = `${this.id}:status`;
    const known = this.cache.get(key, this.ages.statusMs ?? 60_000);
    if (known) return known.value as ProviderStatus;
    return this.#once(key, async () => {
      const status = await this.inner.status();
      this.cache.set(key, status);
      return status;
    });
  }

  async usage(options: { fresh?: boolean } = {}): Promise<ProviderUsage | undefined> {
    const key = `${this.id}:usage`;
    const known = options.fresh ? undefined : this.cache.get(key, this.ages.usageMs ?? 60_000);
    if (known) {
      const value = known.value as Omit<ProviderUsage, "at"> & { at: string };
      // When the provider was asked, not when the cache was read: shown as "40 s ago".
      return { ...value, at: new Date(value.at) };
    }
    return this.#once(key, async () => {
      const usage = await this.inner.usage();
      if (usage) this.cache.set(key, usage);
      return usage;
    });
  }

  #once<T>(key: string, ask: () => Promise<T>): Promise<T> {
    const running = this.#inFlight.get(key);
    if (running) return running as Promise<T>;
    const promise = ask().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, promise);
    return promise;
  }
}
