import { ModelError } from "../model/errors.js";
import type { Model } from "../model/types.js";
import type { ModelOption, Provider, ProviderStatus } from "./types.js";

/** The setting (AGENT_PROVIDERS=none) and id of choosing no model at all. */
export const NO_MODEL = "none";

/** What is said when no model is selected, and how to choose one. */
export const NO_MODEL_TEXT =
  "No model is selected: nothing is sent to any provider. Choose one in /connect (or /model).";

/**
 * No model at all: chosen by the user (so that nothing connected is used,
 * whatever is signed in), or what the chat falls back to when the model it
 * was told to use is switched off or none is ready. It never reasons: each
 * message is refused with a sentence saying how to choose one.
 */
export class NoModelProvider implements Provider {
  readonly id = NO_MODEL;
  readonly name = "No model";
  readonly signIn = "Choose a model in /connect.";

  constructor(private readonly reason: string = NO_MODEL_TEXT) {}

  status(): Promise<ProviderStatus> {
    return Promise.resolve({ installed: false, signedIn: false, detail: this.reason });
  }

  models(): Promise<readonly ModelOption[]> {
    return Promise.resolve([]);
  }

  efforts(): readonly string[] {
    return [];
  }

  usage(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  modelName(id: string): string {
    return id;
  }

  create(): Model {
    const reason = this.reason;
    return {
      name: NO_MODEL,
      open: () => Promise.reject(new ModelError("setup", reason)),
    };
  }
}

/** Whether a provider is "no model". */
export function isNoModel(provider: Pick<Provider, "id"> | undefined): boolean {
  return provider?.id === NO_MODEL;
}
