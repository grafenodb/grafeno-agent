/**
 * Variables that hold keys: the agent's own, and those that would make a
 * provider's program bill per token instead of using its own sign-in
 * (ANTHROPIC_API_KEY switches Claude Code to the API; CODEX_API_KEY and
 * OPENAI_API_KEY switch Codex). An official program the agent starts never
 * gets them: it signs in as its own login says, and nothing else leaks.
 */
export const KEY_VARIABLES = [
  "GRAFENO_AGENT_KEY",
  "GRAFENO_OWNER_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "KIMI_CODE_API_KEY",
  "ZAI_CODING_API_KEY",
  "MINIMAX_CODING_API_KEY",
  "DASHSCOPE_CODING_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
] as const;

/** The environment for a provider's program: the user's, without any key, plus `extra`. */
export function childEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const hidden = new Set<string>(KEY_VARIABLES.map((n) => n.toUpperCase()));
  for (const [name, value] of Object.entries(env)) {
    // Windows names are case-insensitive: compare them as such.
    if (value !== undefined && !hidden.has(name.toUpperCase())) out[name] = value;
  }
  return { ...out, ...extra };
}
