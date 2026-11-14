import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Folders that are never listed or searched: dependencies, builds, git's own. */
export const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  ".cache",
]);

/** Files that hold secrets: never read, written or searched. */
const SECRET_FILES: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$).+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /^credentials(\.json)?$/i,
  /^CLAUDE\.local\.md$/,
];

/** Why a path is never touched, or nothing when it may be. */
export function forbiddenReason(relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === ".ssh" || part === ".gnupg" || part === ".aws")) {
    return "it is inside a folder of keys";
  }
  const name = basename(relativePath);
  if (SECRET_FILES.some((pattern) => pattern.test(name))) {
    return `${name} may hold secrets`;
  }
  return undefined;
}

/**
 * The folder the agent works in (the project), and the rules for paths in
 * it: every path is relative to it and must stay inside it, links
 * included; files that hold secrets are never touched.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The path inside the workspace, or why it is refused (by its words alone). */
  check(path: string): { absolute: string; relative: string } | { refused: string } {
    const absolute = resolve(this.root, path);
    const inside = relative(this.root, absolute);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return { refused: `${path} is outside the project folder` };
    }
    const reason = forbiddenReason(inside);
    if (reason) return { refused: reason };
    return { absolute, relative: inside === "" ? "." : inside.split(sep).join("/") };
  }

  /**
   * The path, checked again where it really leads: a link inside the
   * project may point outside it. Throws when refused.
   */
  async resolve(path: string): Promise<{ absolute: string; relative: string }> {
    const checked = this.check(path);
    if ("refused" in checked) throw new Error(`Not allowed: ${checked.refused}`);
    const root = await realpath(this.root);
    let existing = checked.absolute;
    for (;;) {
      try {
        existing = await realpath(existing);
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    const real = relative(root, existing);
    if (real.startsWith("..") || isAbsolute(real)) {
      throw new Error(`Not allowed: ${path} leads outside the project folder`);
    }
    return checked;
  }
}

/** A glob (`*`, `**`, `?`) as a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob.charAt(i + 1) === "*") {
        const slash = glob.charAt(i + 2) === "/";
        pattern += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a relative path matches a glob; a glob without `/` matches the file's name. */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(glob.includes("/") ? path : basename(path));
}
