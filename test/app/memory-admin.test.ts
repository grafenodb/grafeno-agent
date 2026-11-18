import { GrafenoError, type Grafeno } from "@grafenodb/client";
import { describe, expect, it } from "vitest";
import { memoryAdmin } from "../../src/app/memory-admin.js";

/** A server with the namespaces given: just what `ensure` asks of it. */
function server(names: string[]): { client: Grafeno; made: string[][] } {
  const made: string[][] = [];
  const client = {
    getNamespace: (name: string) =>
      names.includes(name)
        ? Promise.resolve({ name, description: "" })
        : Promise.reject(new GrafenoError(404, "not_found", `namespace ${name} not found`)),
    createNamespace: (name: string, description: string) => {
      made.push([name, description]);
      names.push(name);
      return Promise.resolve({ name, description });
    },
  } as unknown as Grafeno;
  return { client, made };
}

describe("the memory admin", () => {
  it("makes a deleted namespace again, once, and leaves one that is there", async () => {
    const { client, made } = server(["general"]);
    const admin = memoryAdmin(client, "mpi");
    expect(await admin.ensure("general", "general memory")).toBe(false);
    expect(await admin.ensure("mpi", "the project mpi")).toBe(true);
    expect(await admin.ensure("mpi", "the project mpi")).toBe(false);
    expect(made).toEqual([["mpi", "the project mpi"]]);
  });
});
