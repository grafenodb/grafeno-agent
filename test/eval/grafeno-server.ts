import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** A Grafeno server of its own, in memory: clean for each run, gone when it stops. */
export interface EvalGrafeno {
  readonly url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Starts `grafeno serve --memory` (the program in `GRAFENO_BIN`, else
 * `grafeno` from the PATH) on a free port of 127.0.0.1. Only this process
 * is ever stopped.
 */
export async function startGrafeno(): Promise<EvalGrafeno> {
  const program = process.env.GRAFENO_BIN ?? "grafeno";
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(
    program,
    ["serve", "--memory", "--addr", `127.0.0.1:${String(port)}`],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let failed: Error | undefined;
  child.on("error", (error) => {
    failed = error;
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (failed) throw new Error(`Could not start ${program}: ${failed.message}`);
    if (child.exitCode !== null)
      throw new Error(`${program} ended (code ${String(child.exitCode)})`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${program} did not answer at ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => {
          resolve();
        });
        child.kill();
      }),
  };
}
