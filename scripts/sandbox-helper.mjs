#!/usr/bin/env node
// Grafeno Sandbox's helpers in the package: builds this machine's (with the
// system's C compiler), and writes the manifest the agent checks each helper
// against before it runs one (its SHA-256).
//
//   node scripts/sandbox-helper.mjs build [--arch x64|arm64]
//   node scripts/sandbox-helper.mjs manifest [--require linux-x64,linux-arm64,windows-x64,windows-arm64]
//
// Nothing is downloaded: the release builds each helper from native/sandbox
// on its own architecture, and the package carries them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "sandbox");
const [command = "", ...rest] = process.argv.slice(2);

if (command === "build") {
  const requested = rest[rest.indexOf("--arch") + 1];
  const arch =
    requested || (process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined);
  if (!arch) {
    console.error(`No helper is built for ${process.arch}.`);
    process.exit(1);
  }
  if (!new Set(["x64", "arm64"]).has(arch)) {
    console.error(`No helper is built for ${arch}.`);
    process.exit(1);
  }
  if (process.platform === "linux") {
    if (requested && requested !== process.arch) {
      console.error("The Linux helper is built natively on its architecture's runner.");
      process.exit(1);
    }
    const out = join(vendor, `linux-${arch}`, "grafeno-sandbox");
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(
      process.env.CC ?? "cc",
      [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-static",
        "-o",
        out,
        join(root, "native", "sandbox", "grafeno-sandbox.c"),
      ],
      { stdio: "inherit" },
    );
    execFileSync("strip", [out], { stdio: "inherit" });
    chmodSync(out, 0o755);
    console.log(`Built ${out}`);
  } else if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
    const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const installation = execFileSync(
      vswhere,
      ["-latest", "-products", "*", "-property", "installationPath"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (!installation) throw new Error("Visual C++ Build Tools are not installed");
    const out = join(vendor, `windows-${arch}`, "grafeno-sandbox.exe");
    mkdirSync(dirname(out), { recursive: true });
    const toolsRoot = join(installation, "VC", "Tools", "MSVC");
    // The newest installed versions that are complete for this architecture
    // (a runner may have a newer, partial SDK beside a whole one).
    const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    const toolsVersion = readdirSync(toolsRoot)
      .sort(byVersion)
      .reverse()
      .find((v) => existsSync(join(toolsRoot, v, "lib", arch)));
    const kitsRoot = join(programFiles, "Windows Kits", "10");
    const kitsVersion = readdirSync(join(kitsRoot, "Include"))
      .sort(byVersion)
      .reverse()
      .find(
        (v) =>
          existsSync(join(kitsRoot, "Include", v, "um", "windows.h")) &&
          existsSync(join(kitsRoot, "Include", v, "ucrt", "stdio.h")) &&
          existsSync(join(kitsRoot, "Lib", v, "um", arch, "kernel32.lib")) &&
          existsSync(join(kitsRoot, "Lib", v, "ucrt", arch)),
      );
    if (!toolsVersion || !kitsVersion)
      throw new Error("Visual C++ or the Windows SDK is incomplete");
    const tools = join(toolsRoot, toolsVersion);
    const host = process.arch === "arm64" ? "Hostarm64" : "Hostx64";
    const compilerDir = join(tools, "bin", host, arch);
    const compiler = join(compilerDir, "cl.exe");
    const source = join(root, "native", "sandbox", "grafeno-sandbox-windows.c");
    const object = join(dirname(out), "grafeno-sandbox.obj");
    const include = [
      join(tools, "include"),
      ...["ucrt", "shared", "um", "winrt"].map((part) =>
        join(kitsRoot, "Include", kitsVersion, part),
      ),
    ].join(";");
    const lib = [
      join(tools, "lib", arch),
      join(kitsRoot, "Lib", kitsVersion, "ucrt", arch),
      join(kitsRoot, "Lib", kitsVersion, "um", arch),
    ].join(";");
    try {
      execFileSync(
        compiler,
        [
          "/nologo",
          "/W4",
          "/WX",
          "/O2",
          `/Fo${object}`,
          `/Fe${out}`,
          source,
          "/link",
          "advapi32.lib",
          "ole32.lib",
          "userenv.lib",
        ],
        {
          env: {
            ...process.env,
            INCLUDE: include,
            LIB: lib,
            PATH: `${compilerDir};${process.env.PATH ?? ""}`,
          },
          stdio: "inherit",
          windowsHide: true,
        },
      );
    } finally {
      rmSync(object, { force: true });
    }
    console.log(`Built ${out}`);
  } else {
    console.error("Sandbox helpers are built on Linux and Windows runners.");
    process.exit(1);
  }
} else if (command === "manifest") {
  const required = (rest[rest.indexOf("--require") + 1] ?? "")
    .split(",")
    .filter((r) => rest.includes("--require") && r !== "");
  const files = {};
  for (const platform of existsSync(vendor) ? readdirSync(vendor) : []) {
    const name = platform.startsWith("windows-") ? "grafeno-sandbox.exe" : "grafeno-sandbox";
    const file = join(vendor, platform, name);
    if (!existsSync(file)) continue;
    chmodSync(file, 0o755);
    files[`${platform}/${name}`] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  const missing = required.filter(
    (r) => !files[`${r}/${r.startsWith("windows-") ? "grafeno-sandbox.exe" : "grafeno-sandbox"}`],
  );
  if (missing.length > 0) {
    console.error(`Missing helpers: ${missing.join(", ")}`);
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "manifest.json"), `${JSON.stringify({ version, files }, null, 2)}\n`);
  for (const [name, hash] of Object.entries(files)) console.log(`${hash}  ${name}`);
} else {
  console.error(
    "Usage: node scripts/sandbox-helper.mjs build [--arch x64|arm64] | manifest [--require linux-x64,linux-arm64,windows-x64,windows-arm64]",
  );
  process.exit(2);
}
