import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { StartupError, checkGrafeno } from "../src/startup.js";

const config: Config = {
  grafenoUrl: "http://grafeno.test:7810",
  agentKey: "gk_test_0123456789abcdef",
  namespace: "agent",
  model: "fake",
};

interface Seen {
  url: string;
  authorization: string | null;
}

/** A fake server: answers by path, and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response>, seen: Seen[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    const path = new URL(url).pathname;
    const route = routes[path];
    return Promise.resolve(
      route ? route() : json(404, { error: { code: "not_found", message: path } }),
    );
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const healthy = () => json(200, { status: "ok", version: "0.3.0", layout: 18 });
const tools = () =>
  json(200, {
    tools: [
      { name: "recall", description: "", inputSchema: {} },
      { name: "remember", description: "", inputSchema: {} },
    ],
  });

async function failure(promise: Promise<unknown>): Promise<StartupError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StartupError) return error;
    throw error;
  }
  throw new Error("expected a StartupError");
}

describe("checkGrafeno", () => {
  it("reports the server version and the tools the key may run", async () => {
    const seen: Seen[] = [];
    const report = await checkGrafeno(config, {
      fetch: fakeFetch({ "/health": healthy, "/v1/agent/tools": tools }, seen),
    });
    expect(report).toEqual({
      serverVersion: "0.3.0",
      namespace: "agent",
      tools: ["recall", "remember"],
    });
    const toolsCall = seen.find((s) => s.url.endsWith("/v1/agent/tools"));
    expect(toolsCall?.authorization).toBe(`Bearer ${config.agentKey}`);
  });

  it("says when nothing answers", async () => {
    const error = await failure(
      checkGrafeno(config, { fetch: () => Promise.reject(new TypeError("fetch failed")) }),
    );
    expect(error.failure).toBe("unreachable");
    expect(error.message).toContain(config.grafenoUrl);
  });

  it("says when the server is not healthy", async () => {
    const error = await failure(
      checkGrafeno(config, {
        fetch: fakeFetch({ "/health": () => json(200, { status: "degraded", version: "0.3.0" }) }),
      }),
    );
    expect(error.failure).toBe("unhealthy");
  });

  it("says when the key is refused, without printing it", async () => {
    const error = await failure(
      checkGrafeno(config, {
        fetch: fakeFetch({
          "/health": healthy,
          "/v1/agent/tools": () =>
            json(401, { error: { code: "unauthorized", message: "bad token" } }),
        }),
      }),
    );
    expect(error.failure).toBe("unauthorized");
    expect(error.message).toContain("GRAFENO_AGENT_KEY");
    expect(error.message).not.toContain(config.agentKey);
  });

  it("says when the key may not use the namespace", async () => {
    const error = await failure(
      checkGrafeno(config, {
        fetch: fakeFetch({
          "/health": healthy,
          "/v1/agent/tools": () => json(403, { error: { code: "forbidden", message: "no" } }),
        }),
      }),
    );
    expect(error.failure).toBe("forbidden");
    expect(error.message).toContain('"agent"');
  });
});
