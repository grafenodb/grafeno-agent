import type { Vault, VaultAnswer, VaultTool } from "../../src/memory/vault.js";

type Handler = (args: Record<string, unknown>) => VaultAnswer;

const schema = (properties: string[], required: string[] = []) => ({
  type: "object",
  properties: Object.fromEntries(
    [...properties, "namespace"].map((name) => [
      name,
      { type: name === "labels" ? "array" : "string" },
    ]),
  ),
  required,
});

/** A memory that answers like Grafeno's tools do, and records every call. */
export class FakeVault implements Vault {
  readonly namespace = "test";
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly memories: { id: string; text: string; labels: unknown }[] = [];
  #next = 0;

  constructor(private readonly overrides: Record<string, Handler> = {}) {}

  tools(): Promise<VaultTool[]> {
    const tools: VaultTool[] = [
      {
        name: "remember",
        description: "Store a memory.",
        inputSchema: schema(["text", "name", "labels"], ["text"]),
      },
      { name: "recall", description: "Search memory.", inputSchema: schema(["query"], ["query"]) },
      { name: "context", description: "Context.", inputSchema: schema(["query"], ["query"]) },
      {
        name: "checkpoint",
        description: "Save a checkpoint.",
        inputSchema: schema(["task", "summary", "about"], ["task", "summary"]),
      },
      {
        name: "palace_anchor",
        description: "Anchor.",
        inputSchema: schema(["memory", "room", "locus"], ["memory", "room"]),
      },
      { name: "forget", description: "Forget.", inputSchema: schema(["id"], ["id"]) },
      { name: "update", description: "Update.", inputSchema: schema(["id", "text"], ["id"]) },
      {
        name: "merge",
        description: "Merge.",
        inputSchema: schema(["keep", "merge"], ["keep", "merge"]),
      },
    ];
    return Promise.resolve(tools);
  }

  call(name: string, args: Record<string, unknown>): Promise<VaultAnswer> {
    this.calls.push({ name, args });
    const override = this.overrides[name];
    if (override) return Promise.resolve(override(args));
    switch (name) {
      case "remember": {
        const id = `m${String(++this.#next)}`;
        this.memories.push({ id, text: String(args.text), labels: args.labels });
        return json({ id, reused: false });
      }
      case "recall":
        return json({
          results: this.memories.map((m) => ({ id: m.id, name: `Memory ${m.id}`, text: m.text })),
        });
      case "palace_enter":
        return Promise.resolve({ text: "The room holds: nothing yet.", isError: false });
      case "resume":
        return json({ found: false, tasks: [] });
      case "context": {
        const query = String(args.query).toLowerCase();
        const hits = this.memories.filter((m) =>
          query.split(/\W+/).some((word) => word.length > 3 && m.text.toLowerCase().includes(word)),
        );
        return Promise.resolve({
          text:
            hits.length === 0
              ? "No relevant memories found."
              : hits.map((m) => `- ${m.text}`).join("\n"),
          isError: false,
        });
      }
      default:
        return json({ ok: true, id: `x${String(++this.#next)}` });
    }
  }

  called(name: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
}

function json(data: unknown): Promise<VaultAnswer> {
  return Promise.resolve({ text: JSON.stringify(data), isError: false, data });
}
