import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Grafeno } from "@grafenodb/client";

/** The Grafeno release the agent includes. */
export const INCLUDED_VERSION = "0.3.0";
/** Where the included Grafeno listens: not 7810, so that it never meets a Grafeno of the user's own. */
export const INCLUDED_PORT = 7811;
export const INCLUDED_URL = `http://127.0.0.1:${String(INCLUDED_PORT)}`;

interface Asset {
  readonly file: string;
  /** Its SHA-256, from the release: written here, so a download is checked against what was published then. */
  readonly sha256: string;
  readonly size: number;
  readonly exe: string;
}

/** The official builds of the release, by platform. There is none for macOS. */
const ASSETS: Readonly<Record<string, Asset>> = {
  "win32-x64": {
    file: "grafeno-x86_64-pc-windows-msvc.zip",
    sha256: "5ea357790cc6a6d6b10ae3fc87dbfa16e20100b53488bdcf2f6977ac61679311",
    size: 11_422_168,
    exe: "grafeno.exe",
  },
  "linux-x64": {
    file: "grafeno-x86_64-unknown-linux-musl.tar.gz",
    sha256: "96c6095ea765f7c285652901310790436516ccaa54ec30306883772a513bc18d",
    size: 10_617_400,
    exe: "grafeno",
  },
  "linux-arm64": {
    file: "grafeno-aarch64-unknown-linux-musl.tar.gz",
    sha256: "b8fe67781517a584fb33bdd106d2d4eef5a695401a89ccc1d2ebc3a86bead844",
    size: 9_699_721,
    exe: "grafeno",
  },
};

const RELEASE = `https://github.com/grafenodb/grafeno/releases/download/v${INCLUDED_VERSION}`;

/** The build for this computer, if there is one. */
export function includedAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): Asset | undefined {
  return ASSETS[`${platform}-${arch}`];
}

/** Where the included Grafeno lives: its program, its data and its log. */
export interface IncludedPaths {
  readonly dir: string;
  readonly bin: string;
  readonly db: string;
  readonly log: string;
  readonly pid: string;
}

export function includedPaths(
  env: Record<string, string | undefined> = process.env,
): IncludedPaths {
  const base = env.GRAFENO_AGENT_DATA
    ? env.GRAFENO_AGENT_DATA
    : process.platform === "win32" && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, "grafeno-agent")
      : join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "grafeno-agent");
  const dir = join(base, "grafeno");
  const exe = includedAsset()?.exe ?? "grafeno";
  return {
    dir,
    bin: join(dir, INCLUDED_VERSION, exe),
    db: join(dir, "memory.redb"),
    log: join(dir, "grafeno.log"),
    pid: join(dir, "grafeno.pid"),
  };
}

/** Whether the included Grafeno is installed here. */
export function includedInstalled(paths = includedPaths()): boolean {
  return existsSync(paths.bin);
}

/** A new owner token for the included Grafeno. */
export function newOwnerToken(): string {
  return `gfo_${randomBytes(24).toString("base64url")}`;
}

export interface InstallOptions {
  readonly paths?: IncludedPaths;
  /** Told how much is downloaded, in bytes. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly fetch?: typeof fetch;
}

/**
 * Downloads the official build of Grafeno for this computer, checks it
 * against the SHA-256 written above, and unpacks it. Nothing runs from a
 * download that does not match.
 */
export async function installIncluded(options: InstallOptions = {}): Promise<string> {
  const paths = options.paths ?? includedPaths();
  if (existsSync(paths.bin)) return paths.bin;
  const asset = includedAsset();
  if (!asset) {
    throw new Error(
      `Grafeno has no build for ${process.platform}-${process.arch} to include: connect to a Grafeno server instead.`,
    );
  }
  const target = join(paths.dir, INCLUDED_VERSION);
  mkdirSync(target, { recursive: true });
  const archive = join(paths.dir, asset.file);
  const response = await (options.fetch ?? fetch)(`${RELEASE}/${asset.file}`);
  if (!response.ok || !response.body) {
    throw new Error(
      `Downloading Grafeno failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const total = Number(response.headers.get("content-length")) || asset.size;
  const hash = createHash("sha256");
  const out = createWriteStream(archive);
  let done = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      options.onProgress?.(done, total);
      if (!out.write(chunk))
        await new Promise<void>((resolve) =>
          out.once("drain", () => {
            resolve();
          }),
        );
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  const digest = hash.digest("hex");
  if (digest !== asset.sha256) {
    rmSync(archive, { force: true });
    throw new Error(
      `The Grafeno download does not match its published checksum (got ${digest}); it was deleted.`,
    );
  }
  await unpack(archive, target);
  rmSync(archive, { force: true });
  if (!existsSync(paths.bin))
    throw new Error(`Grafeno was unpacked, but ${paths.bin} is not there.`);
  return paths.bin;
}

function unpack(archive: string, target: string): Promise<void> {
  // Windows' own tar reads zip; Git's does not.
  const tar =
    process.platform === "win32" && process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "tar.exe")
      : "tar";
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xf", archive, "-C", target], { windowsHide: true }, (error) => {
      if (error) reject(new Error(`Unpacking Grafeno failed: ${error.message}`));
      else resolve();
    });
  });
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Makes sure the included Grafeno is running, in the background, on
 * 127.0.0.1:7811; it stays running for other agents and later sessions.
 * The owner token goes in through the environment, never the command line.
 */
export async function startIncluded(ownerToken: string, paths = includedPaths()): Promise<string> {
  if (await healthy(INCLUDED_URL)) return INCLUDED_URL;
  if (!existsSync(paths.bin)) {
    throw new Error("The included Grafeno is not installed yet: /palace sets it up.");
  }
  mkdirSync(paths.dir, { recursive: true });
  const log = openSync(paths.log, "a");
  const child = spawn(
    paths.bin,
    ["serve", "--db", paths.db, "--addr", `127.0.0.1:${String(INCLUDED_PORT)}`],
    {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...process.env, GRAFENO_TOKEN: ownerToken },
    },
  );
  child.unref();
  if (child.pid !== undefined) writeFileSync(paths.pid, String(child.pid));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await healthy(INCLUDED_URL)) return INCLUDED_URL;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const tail = existsSync(paths.log) ? readFileSync(paths.log, "utf8").slice(-600).trim() : "";
  throw new Error(
    `The included Grafeno did not start${tail ? `: ${tail}` : ""}. Log: ${paths.log}`,
  );
}

/** Stops the included Grafeno, if this agent started it. */
export function stopIncluded(paths = includedPaths()): boolean {
  if (!existsSync(paths.pid)) return false;
  const pid = Number(readFileSync(paths.pid, "utf8"));
  rmSync(paths.pid, { force: true });
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's own key on the included Grafeno, made with the owner token:
 * a new one, or the old one rotated (a secret is shown only once).
 */
export async function makeAgentKey(
  url: string,
  ownerToken: string,
  namespace: string,
  name = "grafeno-agent",
): Promise<string> {
  const owner = new Grafeno({ url, token: ownerToken });
  // Admin on the namespace and every one under it: each project has its own,
  // made by its first session and dropped with the project.
  const grants = [{ namespace: `${namespace}*`, role: "admin" as const }];
  const known = (await owner.keys()).find((key) => key.name === name);
  if (known) await owner.revokeKey(name);
  const made = await owner.createKey({
    name,
    grants,
    description: "Grafeno Agent's own key: its memory, and each project's",
  });
  return made.secret;
}
