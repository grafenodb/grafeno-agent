/**
 * Keeps secrets out of memory: finds what looks like a key, a password or
 * a token in what is about to be stored. It says what kind of secret it
 * found and where, never the secret itself.
 */

interface Pattern {
  readonly kind: string;
  readonly regex: RegExp;
}

const PATTERNS: readonly Pattern[] = [
  { kind: "a private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "an Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { kind: "an API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "a Stripe key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  {
    kind: "a GitHub token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { kind: "a GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: "a Slack token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "an AWS access key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "a Grafeno key", regex: /\bgfk_[A-Za-z0-9_-]{16,}/ },
  {
    kind: "a JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { kind: "a bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  {
    kind: "a password in a URL",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
  },
  {
    kind: "a password or key assigned a value",
    regex:
      /\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"',;]{6,}/i,
  },
];

export interface SecretFinding {
  /** What kind of secret it looks like. */
  readonly kind: string;
  /** Where in the arguments, such as `text` or `props.note`. */
  readonly path: string;
}

/**
 * Finds what looks like a secret in any string inside `value`. `known` are
 * secrets the agent holds (its own key): any of them found is reported.
 */
export function findSecrets(
  value: unknown,
  known: readonly string[] = [],
  path = "",
): SecretFinding[] {
  if (typeof value === "string") return scan(value, known, path === "" ? "value" : path);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecrets(item, known, `${path}[${String(index)}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      findSecrets(child, known, path === "" ? key : `${path}.${key}`),
    );
  }
  return [];
}

function scan(text: string, known: readonly string[], path: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const secret of known) {
    if (secret.length >= 8 && text.includes(secret)) {
      findings.push({ kind: "one of the agent's own secrets", path });
    }
  }
  for (const { kind, regex } of PATTERNS) {
    if (regex.test(text)) findings.push({ kind, path });
  }
  return findings;
}

/** A message for the model saying what was refused, without the secret. */
export function describeSecrets(findings: readonly SecretFinding[]): string {
  const where = findings.map((f) => `${f.kind} in ${f.path}`).join("; ");
  return `Not stored: it looks like it holds a secret (${where}). Never store keys, passwords or tokens; store what they are for, without the value.`;
}
