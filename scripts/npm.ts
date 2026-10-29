import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUTPUT = join(ROOT, "dist", "npm");
const LOADER = join(ROOT, "npm", "bandar.cjs");
const MANIFEST = join(ROOT, "package.json");
const REPOSITORY = "https://github.com/falentio/bandar";
const LOADER_NAME = "bandar";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const VERSION_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const VISIBILITY_TIMEOUT = 60_000;
const VISIBILITY_INTERVAL = 3_000;

type Platform = {
  readonly name: string;
  readonly os: string;
  readonly file: string;
  readonly libc?: string;
};

const require = createRequire(LOADER);
const { PACKAGES } = require(LOADER) as { readonly PACKAGES: ReadonlyMap<string, Platform> };

const version = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string }).version;

const argv = process.argv.slice(2);
const RELEASE = releaseDirectory(argv);

if (argv.includes("--stage")) {
  await stage(platforms(argv));
} else if (argv.includes("--preflight")) {
  await preflight(stagedOnDisk());
} else if (argv.includes("--publish")) {
  await publish(stagedOnDisk());
} else {
  console.error("npm: pass --stage, --preflight, or --publish");
  process.exit(2);
}

function fail(reason: string): never {
  console.error(`npm: ${reason}`);
  process.exit(1);
}

function split(key: string) {
  const dash = key.indexOf("-");

  return { os: key.slice(0, dash), arch: key.slice(dash + 1) };
}

function artifactName(key: string, platform: Platform): string {
  const exe = platform.file.endsWith(".exe") ? ".exe" : "";

  return `bandar-${version}-${platform.os}-${split(key).arch}${exe}`;
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

  return hash.digest("hex");
}

/** The harness stages fake release files, so a run never needs a 229 MB build or a real release. */
function releaseDirectory(args: readonly string[]): string {
  const index = args.indexOf("--release");
  const path = index === -1 ? undefined : args[index + 1];

  return path === undefined ? join(ROOT, "dist", "release") : resolve(path);
}

function platforms(args: readonly string[]): readonly string[] {
  const keys: string[] = [];

  for (const [index, arg] of args.entries()) {
    if (arg !== "--platform") continue;

    const key = args[index + 1];

    if (key === undefined || !PACKAGES.has(key)) fail(`--platform needs one of ${[...PACKAGES.keys()].join(", ")}`);

    keys.push(key);
  }

  return keys;
}

function shared(name: string, description: string) {
  return {
    name,
    version,
    description,
    license: "UNLICENSED",
    repository: { type: "git", url: `git+${REPOSITORY}.git` },
    homepage: `${REPOSITORY}#readme`,
    bugs: { url: `${REPOSITORY}/issues` },
    publishConfig: { access: "public", provenance: true },
  };
}

function platformManifest(key: string, platform: Platform) {
  const { os, arch } = split(key);

  return {
    ...shared(platform.name, `The bandar binary for ${platform.os} ${arch}. Install bandar instead.`),
    os: [os],
    cpu: [arch],
    ...(platform.libc === undefined ? {} : { libc: [platform.libc] }),
    files: [platform.file],
  };
}

function loaderManifest(staged: readonly string[]) {
  const installed = [...PACKAGES.values()].filter((platform) => staged.includes(platform.name));

  return {
    ...shared(LOADER_NAME, "Run the released bandar binary."),
    bin: { bandar: "bin/bandar.cjs" },
    files: ["bin/bandar.cjs"],
    engines: { node: ">=18.0.0" },
    // Deliberately no os field: npm would refuse the whole install with a bare EBADPLATFORM on a
    // platform we do not build for, before the loader can name the platforms npm does ship.
    optionalDependencies: Object.fromEntries(installed.map((platform) => [platform.name, version])),
  };
}

function writeManifest(directory: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Copies the release assets into publishable directories. The asset is the only source of bytes. */
async function stage(only: readonly string[]): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });

  const staged: string[] = [];

  for (const [key, platform] of PACKAGES) {
    if (only.length > 0 && !only.includes(key)) continue;

    const artifact = join(RELEASE, artifactName(key, platform));

    if (!existsSync(artifact)) fail(`${artifact} is missing; run bun scripts/release.ts first`);

    const expected = (readFileSync(`${artifact}.sha256`, "utf8").trim().split(/\s+/u)[0] ?? "").toLowerCase();

    if ((await digest(artifact)) !== expected) fail(`${artifact} does not match its sha256 file`);

    const directory = join(OUTPUT, platform.name);

    mkdirSync(join(directory, "bin"), { recursive: true });
    copyFileSync(artifact, join(directory, platform.file));
    chmodSync(join(directory, platform.file), 0o755);
    writeManifest(directory, platformManifest(key, platform));
    staged.push(platform.name);
    console.log(`npm: staged ${platform.name} from ${artifact.slice(ROOT.length + 1)}`);
  }

  const directory = join(OUTPUT, LOADER_NAME);

  mkdirSync(join(directory, "bin"), { recursive: true });
  copyFileSync(LOADER, join(directory, "bin", "bandar.cjs"));
  chmodSync(join(directory, "bin", "bandar.cjs"), 0o755);
  writeManifest(directory, loaderManifest(staged));
  console.log(`npm: staged ${LOADER_NAME} for ${staged.join(", ")}`);
}

function stagedOnDisk(): readonly string[] {
  if (!existsSync(OUTPUT)) fail(`${OUTPUT.slice(ROOT.length + 1)} is missing; run bun scripts/npm.ts --stage first`);

  return readdirSync(OUTPUT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function view(args: readonly string[]) {
  const result = Bun.spawnSync({ cmd: [NPM, "view", ...args, "--json"], stdout: "pipe", stderr: "pipe" });

  return { ok: result.exitCode === 0, text: result.stdout.toString().trim() };
}

/** Compares the version the release binary reports with the one npm is about to publish. */
function reportedVersion(): { readonly kind: "ok"; readonly value: string } | { readonly kind: string } {
  if (process.platform !== "linux") return { kind: "skipped" };

  for (const [key, platform] of PACKAGES) {
    if (!key.startsWith("linux-")) continue;

    const artifact = join(RELEASE, artifactName(key, platform));

    if (!existsSync(artifact)) return { kind: "skipped" };

    const result = Bun.spawnSync({ cmd: [artifact, "--version"], stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) return { kind: "unreadable" };

    return { kind: "ok", value: result.stdout.toString().trim() };
  }

  return { kind: "skipped" };
}

/** Every gate that must hold before the first publish. Nothing here writes to the registry. */
async function preflight(staged: readonly string[]): Promise<void> {
  const problems: string[] = [];

  if (!VERSION_TEXT.test(version)) problems.push(`package.json version ${version} is not a release version`);

  const tag = process.env.GITHUB_REF_NAME ?? "";

  if (tag !== `v${version}`) problems.push(`tag ${tag || "(unset)"} does not name package.json version v${version}`);

  for (const name of staged) {
    const manifest = JSON.parse(readFileSync(join(OUTPUT, name, "package.json"), "utf8")) as { version: string };

    if (manifest.version !== version) problems.push(`${name} staged at ${manifest.version}, not ${version}`);
  }

  const reported = reportedVersion();

  if (reported.kind === "unreadable") problems.push("the linux release binary would not report its version");
  if (reported.kind === "ok" && reported.value !== version) {
    problems.push(`the release binary reports ${reported.value}, not ${version}`);
  }

  const owner = view([LOADER_NAME, "repository.url"]);

  if (owner.ok && !owner.text.includes("falentio/bandar")) {
    problems.push(`the npm name ${LOADER_NAME} belongs to ${owner.text}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`npm: ${problem}`);
    process.exit(1);
  }

  console.log(`npm: preflight passed for ${staged.join(", ")} at ${version}`);
}

/** Publishes the platform packages first, so the loader never names a version that is not there. */
async function publish(staged: readonly string[]): Promise<void> {
  const order = [...staged.filter((name) => name !== LOADER_NAME), LOADER_NAME];

  for (const name of order) {
    // A rerun after a half-finished release has to converge, so a name already at this version is
    // done, not fatal.
    if (view([`${name}@${version}`, "version"]).ok) {
      console.log(`npm: ${name}@${version} is already published, skipping`);
      continue;
    }

    const result = Bun.spawnSync({
      cmd: [NPM, "publish", "--provenance", "--access", "public", "--tag", "latest"],
      cwd: join(OUTPUT, name),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) fail(`npm publish failed for ${name}`);

    await visible(name);
    console.log(`npm: published ${name}@${version}`);
  }
}

async function visible(name: string): Promise<void> {
  const deadline = Date.now() + VISIBILITY_TIMEOUT;

  while (Date.now() < deadline) {
    await Bun.sleep(VISIBILITY_INTERVAL);

    if (view([`${name}@${version}`, "version"]).ok) return;
  }

  fail(`${name}@${version} is not readable after 60s, so the loader was not published`);
}
