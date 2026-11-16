#!/usr/bin/env node
// Grafeno Sandbox's helpers in the package: builds this machine's (with the
// system's C compiler), and writes the manifest the agent checks each helper
// against before it runs one (its SHA-256).
//
//   node scripts/sandbox-helper.mjs build      build vendor/sandbox/linux-<arch>/grafeno-sandbox
//   node scripts/sandbox-helper.mjs manifest [--require linux-x64,linux-arm64]
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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "sandbox");
const [command = "", ...rest] = process.argv.slice(2);

if (command === "build") {
  if (process.platform !== "linux") {
    console.error("The Linux helper is built on Linux (the release does it on each architecture).");
    process.exit(1);
  }
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!arch) {
    console.error(`No helper is built for ${process.arch}.`);
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
} else if (command === "manifest") {
  const required = (rest[rest.indexOf("--require") + 1] ?? "")
    .split(",")
    .filter((r) => rest.includes("--require") && r !== "");
  const files = {};
  for (const platform of existsSync(vendor) ? readdirSync(vendor) : []) {
    const file = join(vendor, platform, "grafeno-sandbox");
    if (!existsSync(file)) continue;
    chmodSync(file, 0o755);
    files[`${platform}/grafeno-sandbox`] = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
  }
  const missing = required.filter((r) => !files[`${r}/grafeno-sandbox`]);
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
    "Usage: node scripts/sandbox-helper.mjs build | manifest [--require linux-x64,linux-arm64]",
  );
  process.exit(2);
}
