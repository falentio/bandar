import { closeSync, copyFileSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { BINARY } from "./binary";

const ROOT = join(import.meta.dir, "..");
const RELEASE = join(ROOT, "dist", "release");
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MEMBER = "bandar";

const OS = new Map([
  ["linux", "linux"],
  ["win32", "windows"],
]);

const ARCH = new Map([
  ["x64", "x64"],
  ["arm64", "arm64"],
]);

type Tarball = {
  readonly suffix: string;
  readonly command: readonly string[];
};

const TARBALLS: readonly Tarball[] = [
  { suffix: ".tar.gz", command: ["gzip", "-9", "-c"] },
  { suffix: ".tar.zst", command: ["zstd", "-3", "-q", "-c"] },
];

const version = Bun.env.BANDAR_RELEASE_VERSION?.replace(/^v/, "");

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

function fail(reason: string): never {
  console.error(reason);
  process.exit(1);
}

function sha256OfBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");

  hasher.update(bytes);

  return hasher.digest("hex");
}

async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");

  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);

  return hasher.digest("hex");
}

function stderrOf(result: ReturnType<typeof Bun.spawnSync>): string {
  const text = new TextDecoder().decode(result.stderr).trim();

  return text === "" ? `exited ${String(result.exitCode)}` : text;
}

function published(path: string, digest: string): void {
  console.log(relative(process.cwd(), path));
  console.log(`${digest}  ${basename(path)}`);
}

function compress(source: string, path: string, command: readonly string[]): string | null {
  const output = openSync(path, "w");

  try {
    const result = Bun.spawnSync([...command], {
      stdin: Bun.file(source),
      stdout: output,
      stderr: "pipe",
    });

    if (result.exitCode !== 0) return `could not write ${basename(path)}: ${stderrOf(result)}`;

    return null;
  } finally {
    closeSync(output);
  }
}

type Member =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "failed"; readonly reason: string };

function unpackedMember(path: string): Member {
  const result = Bun.spawnSync(["tar", "-x", "-O", "-f", path, MEMBER]);

  if (result.exitCode !== 0)
    return {
      kind: "failed",
      reason: `${basename(path)} does not give back ${MEMBER}: ${stderrOf(result)}`,
    };

  return { kind: "bytes", bytes: new Uint8Array(result.stdout) };
}

/** Writes both archives, or reports the one reason that stopped them. */
async function writeArchives(digest: string): Promise<string | null> {
  const tar = `${artifact}.tar`;

  try {
    const built = Bun.spawnSync(["tar", "-cf", tar, "-C", dirname(BINARY), MEMBER]);

    if (built.exitCode !== 0) return `could not tar ${MEMBER}: ${stderrOf(built)}`;

    for (const tarball of TARBALLS) {
      const path = `${artifact}${tarball.suffix}`;
      const compressed = compress(tar, path, tarball.command);

      if (compressed !== null) return compressed;

      // A corrupt archive has to fail the release, not the update that downloads it.
      const member = unpackedMember(path);

      if (member.kind === "failed") return member.reason;

      if (sha256OfBytes(member.bytes) !== digest)
        return `${basename(path)} does not hold the released binary`;

      const archiveDigest = await sha256OfFile(path);

      writeFileSync(`${path}.sha256`, `${archiveDigest}  ${basename(path)}\n`);
      published(path, archiveDigest);
    }

    return null;
  } finally {
    rmSync(tar, { force: true });
  }
}

const digest = await sha256OfFile(artifact);

writeFileSync(`${artifact}.sha256`, `${digest}  ${name}\n`);

published(artifact, digest);

if (os === "linux") {
  const problem = await writeArchives(digest);

  if (problem !== null) fail(problem);
}
