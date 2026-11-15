import type {
  ModelChoice,
  ModelOption,
  Provider,
  ProviderParts,
  ProviderStatus,
  ProviderUsage,
} from "./types.js";

/**
 * A provider built from its three parts, kept apart: authentication (who it
 * answers as, billing, usage), model selection, and execution. The rest of
 * the agent sees one `Provider`; each part can be changed (or cached, as
 * the authentication is) without touching the others.
 */
export class ComposedProvider implements Provider {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly parts: ProviderParts,
  ) {}

  get signIn(): string {
    return this.parts.auth.signIn;
  }

  get tiers() {
    return this.parts.catalog.tiers;
  }

  get features() {
    return this.parts.runtime.features;
  }

  status(): Promise<ProviderStatus> {
    return this.parts.auth.status();
  }

  usage(options?: { fresh?: boolean }): Promise<ProviderUsage | undefined> {
    return this.parts.auth.usage(options);
  }

  models(): Promise<readonly ModelOption[]> {
    return this.parts.catalog.models();
  }

  efforts(model?: string): readonly string[] {
    return this.parts.catalog.efforts(model);
  }

  modelName(id: string): string {
    return this.parts.catalog.modelName(id);
  }

  create(choice: ModelChoice) {
    return this.parts.runtime.create(choice);
  }

  /** The same provider with another authentication part (a cached one, say). */
  withAuth(auth: ProviderParts["auth"]): ComposedProvider {
    return new ComposedProvider(this.id, this.name, { ...this.parts, auth });
  }
}
