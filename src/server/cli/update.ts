import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import * as v from "valibot";
import { loadConfig, type Config } from "../config";
import { version as installedVersion } from "../generated/version";
import { settingsIo } from "../settings-io";
import type { Commands, Env } from "./command";
import { detectInstall } from "./install-source";

const COMMAND = "update";
const REPOSITORY = "falentio/bandar";
const INSTALLER = "install.sh from https://github.com/falentio/bandar";

const TOKEN_REQUIRED =
  "update.apiUrl reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN";

const TRUSTED_ASSET_HOSTS = [
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

const TOKEN_VARIABLES = ["BANDAR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const CHECKSUM_PREFIX = /^([0-9a-fA-F]{64})(?:\s|$)/u;
const VERSION_TEXT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const TAG_PATH = /\/releases\/tag\/([^/]+)\/?$/u;

const RELEASE_OS = new Map([
  ["linux", "linux"],
  ["win32", "windows"],
]);

const RELEASE_ARCH = new Map([
  ["x64", "x64"],
  ["arm64", "arm64"],
]);

const ReleaseAssetSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  url: v.pipe(v.string(), v.url()),
});

const ReleaseSchema = v.object({
  tag_name: v.pipe(v.string(), v.minLength(1)),
  assets: v.array(ReleaseAssetSchema),
});

type ReleaseAsset = v.InferOutput<typeof ReleaseAssetSchema>;

export type HttpResponse = {
  readonly status: number;
  readonly body: Uint8Array;
  /** The Location header, which only a caller that asked not to follow redirects can read. */
  readonly location?: string | null;
};

export type HttpSend = (
  url: string,
  headers: Readonly<Record<string, string>>,
  redirect?: "follow" | "manual",
) => Promise<HttpResponse>;

export type UpdateFlags = {
  readonly check: boolean;
  readonly archive: string | null;
};

export type UpdateInvocation =
  | { readonly kind: "run"; readonly flags: UpdateFlags }
  | { readonly kind: "invalid"; readonly reason: string };

export type UpdateRun = {
  readonly configDir: string;
  readonly update: Config["update"];
  readonly env: Env;
  readonly argv: readonly string[];
  readonly installed: string;
  readonly platform: string;
  readonly arch: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly send: HttpSend;
  readonly canWrite: (directory: string) => boolean;
};

export type VersionRelation = "newer" | "same" | "older" | "unknown";

export type ReleaseNames = {
  readonly asset: string;
  readonly checksum: string;
};

type ParsedVersion = {
  readonly core: readonly [number, number, number];
  readonly prerelease: string | null;
};

type Download =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "failed"; readonly reason: string };

/** One published release, and the only two things an installer needs from it. */
type LatestRelease = {
  readonly version: string;
  readonly fetchAsset: (name: string) => Promise<Download>;
};

type LatestLookup =
  | { readonly kind: "latest"; readonly release: LatestRelease }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

type Prepared =
  | {
      readonly kind: "ready";
      readonly bytes: Uint8Array;
      readonly expected: string;
      readonly message: string;
    }
  | { readonly kind: "stopped"; readonly message: string }
  | { readonly kind: "failed"; readonly reason: string };

export function parseUpdateFlags(argv: readonly string[]): UpdateInvocation {
  let check = false;
  let archive: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--check") {
      check = true;
      continue;
    }

    if (argument === "--archive") {
      const path = argv[index + 1];

      if (path === undefined) return { kind: "invalid", reason: "--archive needs a file path" };

      archive = path;
      index += 1;
      continue;
    }

    return { kind: "invalid", reason: `unknown option: ${argument ?? ""}` };
  }

  return { kind: "run", flags: { check, archive } };
}

// The token rides in a header only: never a URL, a printed line, or an argument list.
export function githubToken(env: Env): string | null {
  for (const name of TOKEN_VARIABLES) {
    const value = env[name]?.trim();

    if (value !== undefined && value !== "") return value;
  }

  return null;
}

export function latestTagUrl(web: string): string {
  return `${trimTrailingSlashes(web)}/releases/latest`;
}

export function releaseAssetUrl(web: string, version: string, name: string): string {
  return `${trimTrailingSlashes(web)}/releases/download/v${version}/${name}`;
}

/** The version in a `/releases/tag/v<version>` redirect, which is how the latest tag is read. */
export function versionFromTagLocation(
  location: string | null | undefined,
  requested: string,
): string | null {
  if (location === null || location === undefined || location.trim() === "") return null;

  let url: URL;

  try {
    url = new URL(location.trim(), requested);
  } catch {
    return null;
  }

  const raw = TAG_PATH.exec(url.pathname)?.[1];

  if (raw === undefined) return null;

  let tag: string;

  try {
    tag = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const version = tag.replace(/^v/u, "");

  return VERSION_TEXT.test(version) ? version : null;
}

export function releaseNames(version: string, platform: string, arch: string): ReleaseNames | null {
  const os = RELEASE_OS.get(platform);
  const cpu = RELEASE_ARCH.get(arch);

  if (os === undefined || cpu === undefined) return null;

  const extension = platform === "win32" ? ".exe" : "";
  const asset = `bandar-${version}-${os}-${cpu}${extension}`;

  return { asset, checksum: `${asset}.sha256` };
}

/** How the candidate release stands against the installed version. */
export function compareVersions(installed: string, candidate: string): VersionRelation {
  const left = parseVersion(installed);
  const right = parseVersion(candidate);

  if (left === null || right === null) return "unknown";

  for (const [index, part] of right.core.entries()) {
    const other = left.core[index] ?? 0;

    if (part > other) return "newer";

    if (part < other) return "older";
  }

  if (left.prerelease === right.prerelease) return "same";

  if (right.prerelease === null) return "newer";

  if (left.prerelease === null) return "older";

  return right.prerelease > left.prerelease ? "newer" : "older";
}

export function parseChecksum(text: string): string | null {
  const match = CHECKSUM_PREFIX.exec(text.trim());

  return match?.[1]?.toLowerCase() ?? null;
}

export async function runUpdate(run: UpdateRun): Promise<number> {
  const invocation = parseUpdateFlags(run.argv);

  if (invocation.kind === "invalid") {
    run.stderr(`bandar: ${invocation.reason}`);
    run.stderr("usage: bandar update [--check] [--archive <path>]");

    return 2;
  }

  if (invocation.flags.check) return reportVersions(run);

  return update(run, invocation.flags.archive);
}

export async function run(args: readonly string[], env: Env): Promise<number> {
  let config: Config;

  try {
    config = loadConfig(env, settingsIo);
  } catch (error) {
    const message = error instanceof Error ? error.message : "the environment could not be read";

    console.error(`bandar: ${message.replace(/\s+/gu, " ")}`);

    return 1;
  }

  return runUpdate({
    configDir: config.configDir,
    update: config.update,
    env,
    argv: args,
    installed: installedVersion,
    platform: process.platform,
    arch: process.arch,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    send: sendRequest,
    canWrite: canWriteDirectory,
  });
}

export function register(commands: Commands): void {
  commands.add({
    name: COMMAND,
    summary: "replace this binary with the latest release",
    takesArguments: true,
    run: (env, args) => run(args, env),
  });
}

async function reportVersions(run: UpdateRun): Promise<number> {
  run.stdout(`installed ${run.installed}`);

  const lookup = await lookupLatest(run);

  if (lookup.kind === "absent") {
    // A repository with no published release is a normal state, not a failure to read the feed.
    run.stdout("latest unknown");
    run.stdout("unknown");

    return 0;
  }

  if (lookup.kind === "failed") {
    run.stdout("latest unknown");
    run.stdout("unknown");
    run.stderr(`bandar: ${lookup.reason}`);

    return 1;
  }

  run.stdout(`latest ${lookup.release.version}`);

  const relation = compareVersions(run.installed, lookup.release.version);

  run.stdout(
    relation === "newer" ? "update-available" : relation === "unknown" ? "unknown" : "up-to-date",
  );

  return 0;
}

async function update(run: UpdateRun, archive: string | null): Promise<number> {
  const state = detectInstall(run.configDir, (path) => readFileSync(path, "utf8"));

  if (state.kind === "unknown") {
    run.stderr(
      `bandar: ${state.reason}; an npm install updates with "npm install -g bandar@latest"; otherwise reinstall with ${INSTALLER} to let bandar update itself`,
    );

    return 1;
  }

  const target = state.manifest.path;
  const directory = dirname(target);

  if (!run.canWrite(directory)) {
    run.stderr(
      `bandar: cannot write ${directory}; run "${sudoCommand(run.argv)}" to replace ${target}`,
    );

    return 1;
  }

  const prepared =
    archive === null ? await prepareFromRelease(run, target) : prepareFromArchive(archive, target);

  if (prepared.kind === "stopped") {
    run.stdout(prepared.message);

    return 0;
  }

  if (prepared.kind === "failed") {
    run.stderr(`bandar: ${prepared.reason}`);

    return 1;
  }

  const actual = sha256(prepared.bytes);

  if (actual !== prepared.expected) {
    run.stderr(
      `bandar: checksum mismatch for ${target}: expected ${prepared.expected}, got ${actual}`,
    );

    return 1;
  }

  const replaced = replaceBinary(run, target, prepared.bytes);

  if (replaced !== null) {
    run.stderr(`bandar: ${replaced}`);

    return 1;
  }

  run.stdout(prepared.message);

  return 0;
}

async function prepareFromRelease(run: UpdateRun, target: string): Promise<Prepared> {
  const lookup = await lookupLatest(run);

  if (lookup.kind === "absent")
    return { kind: "failed", reason: `${REPOSITORY} has no published release yet` };

  if (lookup.kind === "failed") return { kind: "failed", reason: lookup.reason };

  return installLatest(run, lookup.release, target);
}

async function installLatest(
  run: UpdateRun,
  release: LatestRelease,
  target: string,
): Promise<Prepared> {
  const relation = compareVersions(run.installed, release.version);

  if (relation === "same") {
    return { kind: "stopped", message: `bandar ${run.installed} is up to date` };
  }

  if (relation === "older") {
    return {
      kind: "stopped",
      message: `bandar ${run.installed} is newer than the latest release ${release.version}; leaving it alone`,
    };
  }

  if (relation === "unknown") {
    return {
      kind: "failed",
      reason: `cannot compare ${run.installed} with the release tag ${release.version}`,
    };
  }

  const names = releaseNames(release.version, run.platform, run.arch);

  if (names === null) {
    return {
      kind: "failed",
      reason: `bandar releases on linux and windows, not ${run.platform}-${run.arch}`,
    };
  }

  const binary = await release.fetchAsset(names.asset);

  if (binary.kind === "failed")
    return { kind: "failed", reason: `could not download ${names.asset}: ${binary.reason}` };

  const checksum = await release.fetchAsset(names.checksum);

  if (checksum.kind === "failed")
    return { kind: "failed", reason: `could not download ${names.checksum}: ${checksum.reason}` };

  const expected = parseChecksum(new TextDecoder().decode(checksum.bytes));

  if (expected === null)
    return { kind: "failed", reason: `${names.checksum} does not hold a sha256 digest` };

  return {
    kind: "ready",
    bytes: binary.bytes,
    expected,
    message: `bandar ${release.version} installed at ${target}`,
  };
}

/** Reads the latest version without a credential, or through the API feed when one is configured. */
async function lookupLatest(run: UpdateRun): Promise<LatestLookup> {
  const api = run.update.apiUrl;

  if (api !== null) {
    const token = githubToken(run.env);

    if (token === null) return { kind: "failed", reason: TOKEN_REQUIRED };

    return lookupApiLatest(run.send, token, api);
  }

  return lookupPublicLatest(run.send, run.update.webUrl);
}

async function lookupPublicLatest(send: HttpSend, web: string): Promise<LatestLookup> {
  const url = latestTagUrl(web);
  let response: HttpResponse;

  try {
    // The tag is in the Location header of a 302, so this is a page request: no API, no hourly
    // rate limit, no credential. Following it would download the release page itself for nothing.
    response = await send(url, { "User-Agent": "bandar-update" }, "manual");
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not read the release feed: ${error instanceof Error ? error.message : "the request failed"}`,
    };
  }

  if (response.status === 404) return { kind: "absent" };

  if (response.status < 300 || response.status >= 400)
    return {
      kind: "failed",
      reason: `the release page answered HTTP ${String(response.status)}, not a redirect to the latest tag`,
    };

  const version = versionFromTagLocation(response.location, url);

  if (version === null)
    return {
      kind: "failed",
      reason: `the release page redirected to ${response.location ?? "no Location header"}, which is not a version tag`,
    };

  return {
    kind: "latest",
    release: { version, fetchAsset: (name) => downloadPublic(send, web, version, name) },
  };
}

async function lookupApiLatest(send: HttpSend, token: string, feed: string): Promise<LatestLookup> {
  let response: HttpResponse;

  try {
    response = await send(feed, {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "bandar-update",
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not read the release feed: ${error instanceof Error ? error.message : "the request failed"}`,
    };
  }

  if (response.status === 404) return { kind: "absent" };

  if (response.status !== 200)
    return { kind: "failed", reason: `the release feed answered HTTP ${String(response.status)}` };

  const decoded = decodeRelease(new TextDecoder().decode(response.body));

  if (decoded.kind === "failed") return decoded;

  const { version, assets } = decoded;

  return {
    kind: "latest",
    release: {
      version,
      fetchAsset: (name) => downloadApi(send, token, assets, version, name, feed),
    },
  };
}

type DecodedRelease =
  | { readonly kind: "ok"; readonly version: string; readonly assets: readonly ReleaseAsset[] }
  | { readonly kind: "failed"; readonly reason: string };

function decodeRelease(text: string): DecodedRelease {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), ReleaseSchema), text);

  if (!parsed.success) {
    const issue = parsed.issues[0];

    return {
      kind: "failed",
      reason: `the release feed sent an unexpected body (${issue?.message ?? "no detail"})`,
    };
  }

  const version = parsed.output.tag_name.replace(/^v/u, "");

  if (!VERSION_TEXT.test(version))
    return { kind: "failed", reason: `the release tag ${parsed.output.tag_name} is not a version` };

  return { kind: "ok", version, assets: parsed.output.assets };
}

async function downloadPublic(
  send: HttpSend,
  web: string,
  version: string,
  name: string,
): Promise<Download> {
  try {
    // github.com answers the asset with a redirect to release-assets.githubusercontent.com, which
    // fetch follows; the bytes land here with no credential anywhere in the request.
    const response = await send(releaseAssetUrl(web, version, name), {
      "User-Agent": "bandar-update",
    });

    if (response.status !== 200)
      return { kind: "failed", reason: `HTTP ${String(response.status)}` };

    return { kind: "bytes", bytes: response.body };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the request failed",
    };
  }
}

async function downloadApi(
  send: HttpSend,
  token: string,
  assets: readonly ReleaseAsset[],
  version: string,
  name: string,
  feed: string,
): Promise<Download> {
  const asset = assets.find((candidate) => candidate.name === name);

  if (asset === undefined)
    return { kind: "failed", reason: `release ${version} publishes no ${name} asset` };

  if (!assetHostAllowed(asset.url, feed))
    return {
      kind: "failed",
      reason: `${hostOf(asset.url) ?? "an unparsable url"} is not an allowed asset host, so bandar will not send its token there`,
    };

  try {
    // The API asset url answers JSON unless the request asks for the octet stream.
    const response = await send(asset.url, {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
      "User-Agent": "bandar-update",
    });

    if (response.status !== 200)
      return { kind: "failed", reason: `HTTP ${String(response.status)}` };

    return { kind: "bytes", bytes: response.body };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the request failed",
    };
  }
}

function prepareFromArchive(archive: string, target: string): Prepared {
  const checksumPath = `${archive}.sha256`;

  let expected: string | null;
  let bytes: Uint8Array;

  try {
    expected = parseChecksum(readFileSync(checksumPath, "utf8"));
    bytes = readFileSync(archive);
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not read ${archive}: ${error instanceof Error ? error.message : "the read failed"}`,
    };
  }

  if (expected === null)
    return { kind: "failed", reason: `${checksumPath} does not hold a sha256 digest` };

  return {
    kind: "ready",
    bytes,
    expected,
    message: `bandar installed from ${archive} at ${target}`,
  };
}

function replaceBinary(run: UpdateRun, target: string, bytes: Uint8Array): string | null {
  // The temp file lives beside the target so the rename stays within one filesystem and keeps the
  // running process's inode alive.
  const temp = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    writeFileSync(temp, bytes, { mode: 0o755 });

    // A Windows mode is mostly advisory, and chmod there only toggles the read-only bit.
    if (run.platform !== "win32") chmodSync(temp, 0o755);

    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });

    if (run.platform === "win32")
      return `Windows locks a running executable, so bandar cannot replace ${target} from inside itself; close bandar, then run the installer again or replace ${target} with the release download`;

    return `could not replace ${target}: ${error instanceof Error ? error.message : "the write failed"}`;
  }

  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function assetHostAllowed(url: string, base: string): boolean {
  const host = hostOf(url);

  if (host === null) return false;

  // A feed may rename an asset, but it does not get to name a host that would receive the token.
  return TRUSTED_ASSET_HOSTS.includes(host) || host === hostOf(base);
}

async function sendRequest(
  url: string,
  headers: Readonly<Record<string, string>>,
  redirect: "follow" | "manual" = "follow",
): Promise<HttpResponse> {
  const response = await fetch(url, { headers, redirect });

  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
    location: response.headers.get("location"),
  };
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/u, "");
}

function canWriteDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);

    return true;
  } catch {
    return false;
  }
}

function sudoCommand(argv: readonly string[]): string {
  return ["sudo", "bandar", COMMAND, ...argv].map(quoteArgument).join(" ");
}

function quoteArgument(argument: string): string {
  return /\s/u.test(argument) ? `"${argument}"` : argument;
}

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_TEXT.exec(text.trim());

  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];

  if (major === undefined || minor === undefined || patch === undefined) return null;

  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: match?.[4] ?? null,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
