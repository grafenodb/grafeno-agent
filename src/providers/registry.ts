import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelOption, Provider, ProviderFeatures, ProviderStatus } from "./types.js";

/** A model as the registry knows it: what the provider calls it, and its efforts. */
export interface ModelCapabilities extends ModelOption {
  readonly efforts: readonly string[];
}

/** What a provider can do here, verified when it could be, and when. */
export interface Capabilities {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly signedIn: boolean;
  readonly version?: string;
  readonly plan?: string;
  /** What to do next, or what is fine. */
  readonly detail: string;
  readonly models: readonly ModelCapabilities[];
  readonly tiers: Readonly<Record<"deep" | "standard" | "light", readonly string[]>>;
  readonly features: ProviderFeatures;
  /** When the models were last read from the provider (ISO). */
  readonly checked: string;
}

/** Why a provider is not used for now, and until when. */
export interface Unavailable {
  readonly reason: string;
  /** When it may be tried again; undefined: until it is checked again. */
  readonly until?: Date;
}

export interface RegistryOptions {
  readonly providers: readonly Provider[];
  /** Where the models read from each provider are kept (JSON). Default: in memory only. */
  readonly file?: string;
  /** Models older than this are read again. Default: 24 hours. */
  readonly maxAgeMs?: number;
  /** A provider's status (installed, signed in, version) is asked again after this. Default: 5 minutes. */
  readonly statusAgeMs?: number;
  readonly now?: () => Date;
}

const UNKNOWN_FEATURES: ProviderFeatures = {
  agentTools: false,
  streaming: false,
  keepsConversation: false,
  usageReport: false,
  nonInteractive: false,
};

interface Cached {
  readonly version?: string;
  readonly checked: string;
  readonly models: readonly ModelCapabilities[];
}

/**
 * What each provider can do, in one place: whether it is installed and
 * signed in (asked of the provider itself, often), which models and
 * efforts it really offers (read with harmless calls, kept with their date
 * in the data folder, and read again when old or when the provider's
 * version changes), and what its adapter can do. It also remembers, for
 * the run, a provider that hit its limit or lost its sign-in, so tasks go
 * elsewhere until it may be tried again.
 */
export class CapabilityRegistry {
  readonly #byId: ReadonlyMap<string, Provider>;
  readonly #status = new Map<string, { at: number; value: ProviderStatus }>();
  readonly #unavailable = new Map<string, Unavailable>();
  #cache: Record<string, Cached>;

  constructor(private readonly options: RegistryOptions) {
    this.#byId = new Map(options.providers.map((p) => [p.id, p]));
    this.#cache = this.#load();
  }

  /** The providers, in the order they were given (the order of preference). */
  get providers(): readonly Provider[] {
    return this.options.providers;
  }

  provider(id: string): Provider | undefined {
    return this.#byId.get(id);
  }

  /** What a provider can do now; `refresh` reads its models again. */
  async capabilities(id: string, options: { refresh?: boolean } = {}): Promise<Capabilities> {
    const provider = this.#byId.get(id);
    if (!provider) throw new Error(`Unknown provider ${id}`);
    const status = await this.#statusOf(provider);
    const cached = this.#cache[id];
    const old =
      cached === undefined ||
      this.#now().getTime() - Date.parse(cached.checked) > (this.options.maxAgeMs ?? 86_400_000) ||
      cached.version !== status.version;
    let entry = cached;
    if (status.installed && status.signedIn && (options.refresh === true || old)) {
      const models = await provider.models().catch(() => [] as readonly ModelOption[]);
      entry = {
        ...(status.version === undefined ? {} : { version: status.version }),
        checked: this.#now().toISOString(),
        models: models.map((m) => ({ ...m, efforts: provider.efforts(m.id) })),
      };
      this.#cache = { ...this.#cache, [id]: entry };
      this.#save();
    }
    const models = entry?.models ?? [];
    return {
      id,
      name: provider.name,
      installed: status.installed,
      signedIn: status.signedIn,
      ...(status.version === undefined ? {} : { version: status.version }),
      ...(status.plan === undefined ? {} : { plan: status.plan }),
      detail: status.detail,
      models,
      tiers: provider.tiers ?? {
        deep: models.map((m) => m.id),
        standard: models.map((m) => m.id),
        light: [...models].reverse().map((m) => m.id),
      },
      features: provider.features ?? UNKNOWN_FEATURES,
      checked: entry?.checked ?? this.#now().toISOString(),
    };
  }

  /** Every provider's capabilities, in order. */
  async all(): Promise<Capabilities[]> {
    return Promise.all(this.options.providers.map((p) => this.capabilities(p.id)));
  }

  /**
   * The providers a task may be given to now, in order: installed, signed
   * in, able to use the agent's tools without a person, and not set aside.
   */
  async ready(): Promise<Capabilities[]> {
    const all = await this.all();
    return all.filter(
      (c) =>
        c.installed &&
        c.signedIn &&
        c.features.agentTools &&
        c.features.nonInteractive &&
        this.unavailable(c.id) === undefined,
    );
  }

  /** Sets a provider aside: no new task goes to it until `until` (or until it is checked again). */
  setAside(id: string, why: Unavailable): void {
    this.#unavailable.set(id, why);
    this.#status.delete(id); // Its sign-in is asked again before it is used.
  }

  /** Why a provider is set aside now, or undefined when it may be used. */
  unavailable(id: string): Unavailable | undefined {
    const why = this.#unavailable.get(id);
    if (!why) return undefined;
    if (why.until && why.until.getTime() <= this.#now().getTime()) {
      this.#unavailable.delete(id);
      return undefined;
    }
    return why;
  }

  async #statusOf(provider: Provider): Promise<ProviderStatus> {
    const known = this.#status.get(provider.id);
    if (known && this.#now().getTime() - known.at < (this.options.statusAgeMs ?? 300_000)) {
      return known.value;
    }
    const value: ProviderStatus = await provider.status().catch((error: unknown) => ({
      installed: false,
      signedIn: false,
      detail: error instanceof Error ? error.message : String(error),
    }));
    this.#status.set(provider.id, { at: this.#now().getTime(), value });
    return value;
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #load(): Record<string, Cached> {
    if (!this.options.file) return {};
    try {
      return JSON.parse(readFileSync(this.options.file, "utf8")) as Record<string, Cached>;
    } catch {
      return {};
    }
  }

  #save(): void {
    if (!this.options.file) return;
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileSync(this.options.file, `${JSON.stringify(this.#cache, null, 2)}\n`);
    } catch {
      // A cache that cannot be written is read again next time.
    }
  }
}
