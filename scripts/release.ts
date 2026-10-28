import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { BINARY } from "./binary";

const ROOT = join(import.meta.dir, "..");
const RELEASE = join(ROOT, "dist", "release");
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const OS = new Map([
  ["linux", "linux"],
  ["win32", "windows"],
]);

const ARCH = new Map([
  ["x64", "x64"],
  ["arm64", "arm64"],
]);

const version = Bun.env.BANDAR_RELEASE_VERSION;

if (version === undefined || !VERSION.test(version)) {
  console.error(
    `BANDAR_RELEASE_VERSION must be a version such as 1.2.3 or 1.2.3-rc.1, got ${JSON.stringify(version ?? "")}`,
  );
  process.exit(1);
}

const os = OS.get(process.platform);

if (os === undefined) {
  console.error(`bandar releases on linux and windows, not ${process.platform}`);
  process.exit(1);
}

const arch = ARCH.get(process.arch);

if (arch === undefined) {
  console.error(`bandar releases on x64 and arm64, not ${process.arch}`);
  process.exit(1);
}

const name = `bandar-${version}-${os}-${arch}${extname(BINARY)}`;
const artifact = join(RELEASE, name);

rmSync(RELEASE, { recursive: true, force: true });

mkdirSync(RELEASE, { recursive: true });

copyFileSync(BINARY, artifact);

const hasher = new Bun.CryptoHasher("sha256");

for await (const chunk of Bun.file(artifact).stream()) {
  hasher.update(chunk);
}

const line = `${hasher.digest("hex")}  ${name}\n`;

writeFileSync(`${artifact}.sha256`, line);

console.log(relative(process.cwd(), artifact));

console.log(line.trimEnd());
