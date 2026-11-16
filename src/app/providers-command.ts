import { billingAllowed } from "../providers/billing.js";
import { installClaudeApi } from "../providers/claude-api.js";
import { autoMembers, KNOWN_PROVIDERS } from "../providers/index.js";
import {
  canonicalProvider,
  PROVIDER_PROFILES,
  providerEnabled,
  switchVariables,
} from "../providers/profiles.js";
import type { Provider, ProviderStatus } from "../providers/types.js";

export interface ProvidersCommandOptions {
  readonly say: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
  /** Saves settings to the settings file (and this run). */
  readonly saveSettings: (values: Record<string, string>) => void;
  /** The providers; default: every known one. */
  readonly providers?: readonly Provider[];
  readonly install?: (env: Record<string, string | undefined>) => Promise<number>;
}

const USAGE = `grafeno-agent providers                     each provider: how it signs in, switched on or off, ready or why not
grafeno-agent providers disable <name>      switch one off at once (PROVIDER_<NAME>_ENABLED=false)
grafeno-agent providers enable <name>       switch it on again
grafeno-agent providers install claude-api  install the Claude Agent SDK it needs (pinned, in the data folder)`;

/** The providers as lines for a person: each one's sign-in, switch, standing and state. */
export function describeProviders(
  rows: readonly { provider: Provider; status: ProviderStatus }[],
  env: Record<string, string | undefined>,
): string[] {
  const auto = safeAuto(env);
  const lines: string[] = [];
  for (const { provider, status } of rows) {
    const profile = PROVIDER_PROFILES[provider.id];
    const on = providerEnabled(provider.id, env);
    const ready = on && status.installed && status.signedIn;
    const billed = status.billing?.kind === "metered";
    lines.push(
      `${(profile?.shownAs ?? provider.id).padEnd(18)} ${provider.name.slice(0, 24).padEnd(24)} ${(profile?.auth ?? "?").padEnd(17)} ${on ? "on " : "off"}  ${ready ? "ready" : "not ready"}${auto.includes(provider.id) ? " · in Auto" : ""}`,
    );
    lines.push(`${" ".repeat(19)}${status.detail}`);
    if (billed) {
      lines.push(
        `${" ".repeat(19)}Billed per token: ${billingAllowed(provider.id, env) ? "allowed (AGENT_ALLOW_BILLING)" : "not allowed, so never used"}.`,
      );
    }
    if (profile?.compliance === "pending-anthropic-review") {
      lines.push(`${" ".repeat(19)}Compliance: pending review by Anthropic. ${profile.note ?? ""}`);
    }
  }
  return lines;
}

function safeAuto(env: Record<string, string | undefined>): string[] {
  try {
    return autoMembers(env);
  } catch {
    return [];
  }
}

/** `grafeno-agent providers …`: the providers, their switches, and claude-api's install. */
export async function providersCommand(
  args: readonly string[],
  options: ProvidersCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const { say } = options;
  const sub = args[0] ?? "list";
  const known = (name: string | undefined) => {
    const id = canonicalProvider(name ?? "");
    return id in KNOWN_PROVIDERS ? id : undefined;
  };
  switch (sub) {
    case "list":
    case "ls": {
      const providers = options.providers ?? Object.values(KNOWN_PROVIDERS).map((make) => make());
      const rows = await Promise.all(
        providers.map(async (provider) => ({
          provider,
          status: await provider.status().catch((error: unknown) => ({
            installed: false,
            signedIn: false,
            detail: error instanceof Error ? error.message : String(error),
          })),
        })),
      );
      for (const line of describeProviders(rows, env)) say(line);
      return 0;
    }
    case "enable":
    case "disable": {
      const id = known(args[1]);
      if (!id) {
        say(
          `Name a provider: ${Object.values(PROVIDER_PROFILES)
            .map((p) => p.shownAs)
            .join(", ")}.`,
        );
        return 2;
      }
      // Every switch of the provider, its aliases' too, set the same way.
      const value = sub === "enable" ? "true" : "false";
      options.saveSettings(Object.fromEntries(switchVariables(id).map((name) => [name, value])));
      const shown = PROVIDER_PROFILES[id]?.shownAs ?? id;
      say(
        sub === "enable"
          ? `${shown} is switched on.`
          : `${shown} is switched off: no session, run or fallback uses it, starting now.`,
      );
      return 0;
    }
    case "install": {
      if (known(args[1]) !== "claude-api") {
        say("Only claude-api has something to install: grafeno-agent providers install claude-api");
        return 2;
      }
      say("Installing the Claude Agent SDK (pinned) into the agent's data folder…");
      const code = await (options.install ?? installClaudeApi)(env);
      say(
        code === 0
          ? "Installed. Then: grafeno-agent login claude-api (an Anthropic API key, billed per token)."
          : `npm ended with code ${String(code)}: see above.`,
      );
      return code;
    }
    default:
      say(USAGE);
      return sub === "help" || sub === "--help" ? 0 : 2;
  }
}
