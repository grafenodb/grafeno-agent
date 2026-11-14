import { describe, expect, it } from "vitest";
import { describeSecrets, findSecrets } from "../../src/memory/secrets.js";

// Built at run time, so no secret-shaped text sits in the repository.
const fake = (prefix: string, length: number) => prefix + "a1B2c3D4e5".repeat(8).slice(0, length);

describe("findSecrets", () => {
  it.each([
    ["an Anthropic API key", fake("sk-ant-", 40)],
    ["a GitHub token", fake("ghp_", 36)],
    ["an AWS access key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["a Grafeno key", fake("gfk_", 32)],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["a JSON Web Token", `eyJ${fake("", 12)}.eyJ${fake("", 12)}.${fake("", 12)}`],
    ["a bearer token", `Authorization: Bearer ${fake("", 30)}`],
    ["a password in a URL", "postgres://admin:hunter22@db.local/app"],
    ["a password or key assigned a value", "password = correct-horse"],
    ["a password or key assigned a value", 'API_KEY: "abcdef123456"'],
  ])("finds %s", (kind, text) => {
    expect(findSecrets({ text: `see ${text} here` }).map((f) => f.kind)).toContain(kind);
  });

  it("finds the agent's own secrets, wherever they are", () => {
    const own = "my-own-secret-value";
    expect(findSecrets({ props: { notes: [`x ${own}`] } }, [own])).toEqual([
      { kind: "one of the agent's own secrets", path: "props.notes[0]" },
    ]);
  });

  it("lets ordinary text through", () => {
    const text =
      "The user prefers tabs. The API key is kept in .env as GRAFENO_AGENT_KEY. Use a password manager. Token counts matter.";
    expect(findSecrets({ text, labels: ["Preference"] })).toEqual([]);
  });

  it("says what it refused without repeating the secret", () => {
    const secret = fake("ghp_", 36);
    const message = describeSecrets(findSecrets({ text: secret }));
    expect(message).toContain("a GitHub token in text");
    expect(message).not.toContain(secret);
  });
});
