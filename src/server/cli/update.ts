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
import { parseConfig } from "../config";
import { version as installedVersion } from "../generated/version";
import type { Commands, Env } from "./command";
import { detectInstall } from "./install-source";

const COMMAND = "update";
const REPOSITORY = "falentio/bandar";
const DEFAULT_API_BASE = "https://api.github.com";
const INSTALLER = "install.sh from https://github.com/falentio/bandar";
const TOKEN_REQUIRED = "a GitHub token is required: set BANDAR_GITHUB_TOKEN";
const TOKEN_VARIABLES = ["BANDAR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const CHECKSUM_PREFIX = /^([0-9a-fA-F]{64})(?:\s|$)/u;
const VERSION_TEXT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

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

type Release = {
  readonly version: string;
  readonly assets: readonly ReleaseAsset[];
};

export type HttpResponse = {
  readonly status: number;
  readonly body: Uint8Array;
};

export type HttpSend = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<HttpResponse>;

export type UpdateFlags = {
  readonly check: boolean;
  readonly archive: string | null;
};

export type UpdateInvocation =
  | { readonly kind: "run"; readonly flags: UpdateFlags }
  | { readonly kind: "invalid"; readonly reason: string };

export type UpdateRun = {
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

type ReleaseLookup =
  | { readonly kind: "release"; readonly release: Release }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

type Download =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
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

type ConfigDirectory =
  | { readonly kind: "dir"; readonly directory: string }
  | { readonly kind: "error"; readonly reason: string };

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

export function apiBase(env: Env): string {
  const override = env.BANDAR_UPDATE_URL?.trim();

  // The override exists so a stub server can stand in for GitHub on an offline host and in tests.
  return override !== undefined && override !== "" ? override : DEFAULT_API_BASE;
}

export function latestReleaseUrl(base: string): string {
  return `${base.replace(/\/+$/u, "")}/repos/${REPOSITORY}/releases/latest`;
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
  return runUpdate({
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
  const token = githubToken(run.env);

  run.stdout(`installed ${run.installed}`);

  if (token === null) {
    run.stdout("latest unknown");
    run.stdout("unknown");
    run.stderr(TOKEN_REQUIRED);

    return 1;
  }

  const lookup = await lookupLatest(run.send, token, apiBase(run.env));

  if (lookup.kind !== "release") {
    // A private repository answers 404 for its own missing release, which is a normal state.
    run.stdout("latest unknown");
    run.stdout("unknown");

    return 0;
  }

  run.stdout(`latest ${lookup.release.version}`);

  const relation = compareVersions(run.installed, lookup.release.version);

  run.stdout(
    relation === "newer" ? "update-available" : relation === "unknown" ? "unknown" : "up-to-date",
  );

  return 0;
}

async function update(run: UpdateRun, archive: string | null): Promise<number> {
  const config = readConfigDirectory(run.env);

  if (config.kind === "error") {
    run.stderr(`bandar: ${config.reason}`);

    return 1;
  }

  const state = detectInstall(config.directory, (path) => readFileSync(path, "utf8"));

  if (state.kind === "unknown") {
    run.stderr(`bandar: ${state.reason}; reinstall with ${INSTALLER} to let bandar update itself`);

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

  let prepared: Prepared;

  if (archive === null) {
    const token = githubToken(run.env);

    if (token === null) {
      run.stderr(TOKEN_REQUIRED);

      return 1;
    }

    prepared = await prepareFromRelease(run, token, target);
  } else {
    prepared = prepareFromArchive(archive, target);
  }

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

async function prepareFromRelease(
  run: UpdateRun,
  token: string,
  target: string,
): Promise<Prepared> {
  const lookup = await lookupLatest(run.send, token, apiBase(run.env));

  if (lookup.kind === "absent")
    return { kind: "failed", reason: `${REPOSITORY} has no published release yet` };

  if (lookup.kind === "failed")
    return { kind: "failed", reason: `could not read the latest release: ${lookup.reason}` };

  const release = lookup.release;
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

  const asset = release.assets.find((candidate) => candidate.name === names.asset);
  const checksum = release.assets.find((candidate) => candidate.name === names.checksum);

  if (asset === undefined || checksum === undefined) {
    return {
      kind: "failed",
      reason: `release ${release.version} has no ${names.asset} with its ${names.checksum}`,
    };
  }

  const binary = await download(run.send, token, asset.url);

  if (binary.kind === "failed")
    return { kind: "failed", reason: `could not download ${names.asset}: ${binary.reason}` };

  const checksumText = await download(run.send, token, checksum.url);

  if (checksumText.kind === "failed")
    return {
      kind: "failed",
      reason: `could not download ${names.checksum}: ${checksumText.reason}`,
    };

  const expected = parseChecksum(new TextDecoder().decode(checksumText.bytes));

  if (expected === null)
    return { kind: "failed", reason: `${names.checksum} does not hold a sha256 digest` };

  return {
    kind: "ready",
    bytes: binary.bytes,
    expected,
    message: `bandar ${release.version} installed at ${target}`,
  };
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

    return `could not replace ${target}: ${error instanceof Error ? error.message : "the write failed"}`;
  }

  return null;
}

async function lookupLatest(send: HttpSend, token: string, base: string): Promise<ReleaseLookup> {
  let response: HttpResponse;

  try {
    response = await send(latestReleaseUrl(base), {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "bandar-update",
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the release feed could not be reached",
    };
  }

  if (response.status === 404) return { kind: "absent" };

  if (response.status !== 200)
    return { kind: "failed", reason: `the release feed answered HTTP ${String(response.status)}` };

  return decodeRelease(new TextDecoder().decode(response.body));
}

function decodeRelease(text: string): ReleaseLookup {
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

  return { kind: "release", release: { version, assets: parsed.output.assets } };
}

async function download(send: HttpSend, token: string, url: string): Promise<Download> {
  try {
    // The asset URL answers JSON unless the request asks for the octet stream.
    const response = await send(url, {
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
      reason: error instanceof Error ? error.message : "the download failed",
    };
  }
}

async function sendRequest(
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<HttpResponse> {
  const response = await fetch(url, { headers, redirect: "follow" });

  return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
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

function readConfigDirectory(env: Env): ConfigDirectory {
  try {
    // A random secret and its warning have nothing to do with updating, so hand the parser a
    // placeholder: it stays the one reader of BANDAR_CONFIG_DIR.
    const config = parseConfig({ ...env, BANDAR_AUTH_SECRET: "update" });

    return { kind: "dir", directory: config.configDir };
  } catch (error) {
    return {
      kind: "error",
      reason: (error instanceof Error
        ? error.message
        : "the environment could not be read"
      ).replace(/\s+/gu, " "),
    };
  }
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
