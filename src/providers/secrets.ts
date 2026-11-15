import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a provider's key is kept, outside the agent's memory (never in
 * Grafeno, never in its settings file, never in a log). The key goes to
 * the system's own store through standard input or an environment
 * variable, never a command's arguments.
 */
export interface SecretStore {
  /** Which store it is, for a person: "Windows (DPAPI)", "Secret Service"… */
  readonly name: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/** Runs a program with an environment and standard input; gives what it printed. */
export type RunProgram = (
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string>; input?: string },
) => Promise<string>;

const runProgram: RunProgram = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, ...options.env },
      },
      (error, stdout) => {
        if (error) reject(new Error(`${command} failed`, { cause: error }));
        else resolve(stdout);
      },
    );
    child.stdin?.end(options.input ?? "");
  });

const SERVICE = "grafeno-agent";

/**
 * Windows: the secret encrypted with DPAPI for the current user (only that
 * user, on this machine, can read it), in a file of the agent's data
 * folder. PowerShell's own `ConvertFrom-SecureString`, with the secret
 * passed in an environment variable.
 */
export class DpapiStore implements SecretStore {
  readonly name = "Windows (DPAPI, this user only)";

  constructor(
    private readonly folder: string,
    private readonly run: RunProgram = runProgram,
  ) {}

  async get(account: string): Promise<string | undefined> {
    const file = this.#file(account);
    if (!existsSync(file)) return undefined;
    const out = await this.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s = ConvertTo-SecureString -String $env:GA_SEALED; [System.Net.NetworkCredential]::new('', $s).Password",
      ],
      { env: { GA_SEALED: readFileSync(file, "utf8").trim() } },
    );
    return out.trim() || undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    const sealed = await this.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "ConvertTo-SecureString -String $env:GA_SECRET -AsPlainText -Force | ConvertFrom-SecureString",
      ],
      { env: { GA_SECRET: secret } },
    );
    mkdirSync(this.folder, { recursive: true });
    writeFileSync(this.#file(account), `${sealed.trim()}\n`, { mode: 0o600 });
  }

  delete(account: string): Promise<void> {
    rmSync(this.#file(account), { force: true });
    return Promise.resolve();
  }

  #file(account: string): string {
    return join(this.folder, `${account}.dpapi`);
  }
}

/** Linux: the desktop's Secret Service (GNOME Keyring, KWallet) through `secret-tool`. */
export class SecretServiceStore implements SecretStore {
  readonly name = "Secret Service (secret-tool)";

  constructor(private readonly run: RunProgram = runProgram) {}

  async get(account: string): Promise<string | undefined> {
    try {
      const out = await this.run(
        "secret-tool",
        ["lookup", "service", SERVICE, "account", account],
        {},
      );
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    await this.run(
      "secret-tool",
      ["store", `--label=Grafeno Agent: ${account}`, "service", SERVICE, "account", account],
      { input: secret },
    );
  }

  async delete(account: string): Promise<void> {
    await this.run("secret-tool", ["clear", "service", SERVICE, "account", account], {});
  }
}

/**
 * macOS: the login Keychain. Reading goes through `security`; storing a
 * secret with `security` takes it as an argument, which other processes
 * could see, so the agent does not store it here: the person adds it with
 * `security add-generic-password -s grafeno-agent -a <account> -w` (which
 * asks for it), or sets the environment variable.
 */
export class KeychainStore implements SecretStore {
  readonly name = "macOS Keychain";

  constructor(private readonly run: RunProgram = runProgram) {}

  async get(account: string): Promise<string | undefined> {
    try {
      const out = await this.run(
        "security",
        ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
        {},
      );
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  set(account: string): Promise<void> {
    return Promise.reject(
      new Error(
        `On macOS, add it yourself: security add-generic-password -s ${SERVICE} -a ${account} -w`,
      ),
    );
  }

  async delete(account: string): Promise<void> {
    await this.run("security", ["delete-generic-password", "-s", SERVICE, "-a", account], {});
  }
}

/** The system's secure store for this platform. */
export function systemSecretStore(dataFolder: string): SecretStore {
  if (process.platform === "win32") return new DpapiStore(join(dataFolder, "secrets"));
  if (process.platform === "darwin") return new KeychainStore();
  return new SecretServiceStore();
}
