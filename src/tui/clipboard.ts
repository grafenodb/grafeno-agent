import { spawn } from "node:child_process";

/** The system's copy command for this platform, first found first. */
function copiers(platform: NodeJS.Platform): readonly (readonly [string, readonly string[]])[] {
  if (platform === "win32") {
    // UTF-8 in, so accents and symbols arrive intact (clip.exe would garble them).
    return [
      [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      ],
    ];
  }
  if (platform === "darwin") return [["pbcopy", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

function run(command: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => {
        resolve(false);
      });
      child.on("close", (code) => {
        resolve(code === 0);
      });
      child.stdin.end(text, "utf8");
    } catch {
      resolve(false);
    }
  });
}

/** OSC 52: asks the terminal itself to set the clipboard (Windows Terminal, iTerm2, kitty…). */
export function osc52(text: string): string {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  return `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}${BEL}`;
}

/**
 * Puts text on the system clipboard: the platform's copy command, or else
 * the terminal's own clipboard sequence. Says which way it went.
 */
export async function copyToClipboard(
  text: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly write?: (data: string) => void;
    readonly runner?: typeof run;
  } = {},
): Promise<"system" | "terminal"> {
  const runner = options.runner ?? run;
  for (const [command, args] of copiers(options.platform ?? process.platform)) {
    if (await runner(command, args, text)) return "system";
  }
  (options.write ?? ((data: string) => process.stdout.write(data)))(osc52(text));
  return "terminal";
}
