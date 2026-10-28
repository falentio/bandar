import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { Commands } from "./command";
import { detectInstall } from "./install-source";
import {
  apiBase,
  compareVersions,
  githubToken,
  latestReleaseUrl,
  parseChecksum,
  parseUpdateFlags,
  register,
  releaseNames,
  runUpdate,
  type HttpSend,
  type UpdateRun,
} from "./update";

const workspaces: string[] = [];

const workspace = (): string => {
  const path = mkdtempSync(join(tmpdir(), "bandar-update-"));

  workspaces.push(path);

  return path;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const sha256 = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");

  hasher.update(bytes);

  return hasher.digest("hex");
};

const token = "stub-token";

const fileReader =
  (files: ReadonlyMap<string, string>) =>
  (path: string): string => {
    const text = files.get(path);

    if (text === undefined) {
      const error: Error & { code?: string } = new Error(`ENOENT: no such file, open '${path}'`);

      error.code = "ENOENT";

      throw error;
    }

    return text;
  };

const manifestText = (source: string, path: string): string =>
  JSON.stringify({ source, version: "0.1.0", path });

type Fixture = {
  readonly directory: string;
  readonly configDir: string;
  readonly target: string;
  readonly env: Record<string, string | undefined>;
};

const fixtureOf = (source: string | null): Fixture => {
  const directory = workspace();
  const configDir = join(directory, "config");
  const target = join(directory, "bin", "bandar");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(target, "old binary");

  if (source !== null) writeFileSync(join(configDir, "install.json"), manifestText(source, target));

  return {
    directory,
    configDir,
    target,
    env: { BANDAR_CONFIG_DIR: configDir, BANDAR_GITHUB_TOKEN: token },
  };
};

type ServeOptions = {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly checksum?: string;
  readonly status?: number;
  readonly assets?: readonly { readonly name: string; readonly url: string }[];
};

const releaseOf = (options: ServeOptions, platform: string): string => {
  const names = releaseNames(options.version, platform, "x64");

  if (names === null) throw new Error("the fixture platform has no asset");

  return JSON.stringify({
    tag_name: `v${options.version}`,
    assets: options.assets ?? [
      { name: names.asset, url: `https://assets.test/${names.asset}` },
      { name: names.checksum, url: `https://assets.test/${names.checksum}` },
    ],
  });
};

type Request = { readonly url: string; readonly accept: string | undefined };

type Recorded = {
  readonly run: UpdateRun;
  readonly lines: string[];
  readonly errors: string[];
  readonly requests: Request[];
};

type RunOptions = {
  readonly env: Record<string, string | undefined>;
  readonly argv?: readonly string[];
  readonly installed?: string;
  readonly platform?: string;
  readonly canWrite?: boolean;
  readonly send?: HttpSend;
};

const runOf = (fixture: Fixture, options: RunOptions): Recorded => {
  const lines: string[] = [];
  const errors: string[] = [];
  const requests: Request[] = [];
  const send: HttpSend = options.send ?? (async () => ({ status: 404, body: new Uint8Array() }));

  const recording: HttpSend = async (url, headers) => {
    requests.push({ url, accept: headers.Accept });

    return send(url, headers);
  };

  return {
    lines,
    errors,
    requests,
    run: {
      env: { ...fixture.env, ...options.env },
      argv: options.argv ?? [],
      installed: options.installed ?? "0.1.0",
      platform: options.platform ?? "linux",
      arch: "x64",
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
      send: recording,
      canWrite: () => options.canWrite ?? true,
    },
  };
};

const serving = (options: ServeOptions, platform = "linux"): HttpSend => {
  const names = releaseNames(options.version, platform, "x64");

  return async (url) => {
    if (url === latestReleaseUrl("https://api.test")) {
      return { status: options.status ?? 200, body: encode(releaseOf(options, platform)) };
    }

    if (names !== null && url === `https://assets.test/${names.asset}`) {
      return { status: 200, body: options.bytes };
    }

    if (names !== null && url === `https://assets.test/${names.checksum}`) {
      const digest = options.checksum ?? sha256(options.bytes);

      return { status: 200, body: encode(`${digest}  ${names.asset}\n`) };
    }

    return { status: 404, body: new Uint8Array() };
  };
};

const API_ENV = { BANDAR_UPDATE_URL: "https://api.test" };

const tempFilesIn = (directory: string): readonly string[] =>
  readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));

describe("install source", () => {
  test("a missing install.json is an unknown source", () => {
    expect(detectInstall("/srv/bandar", fileReader(new Map()))).toEqual({
      kind: "unknown",
      reason: "no install.json records an install source",
    });
  });

  test("malformed JSON is an unknown source with the parse detail", () => {
    const text = '{"source":';

    const state = detectInstall(
      "/srv/bandar",
      fileReader(new Map([["/srv/bandar/install.json", text]])),
    );

    expect(state.kind).toBe("unknown");
    expect(state.kind === "unknown" ? state.reason : "").toContain("install.json is unreadable");
  });

  test("a recorded unknown source is an unknown source", () => {
    const text = manifestText("unknown", "/usr/local/bin/bandar");

    expect(
      detectInstall("/srv/bandar", fileReader(new Map([["/srv/bandar/install.json", text]]))),
    ).toEqual({ kind: "unknown", reason: "install.json records the source as unknown" });
  });

  test("a valid manifest reports its source and path", () => {
    const text = manifestText("install-script", "/usr/local/bin/bandar");

    expect(
      detectInstall("/srv/bandar", fileReader(new Map([["/srv/bandar/install.json", text]]))),
    ).toEqual({
      kind: "reported",
      manifest: { source: "install-script", version: "0.1.0", path: "/usr/local/bin/bandar" },
    });
  });

  test("a manual install reports its source too", () => {
    const text = manifestText("manual", "/opt/bandar/bandar");

    const state = detectInstall(
      "/srv/bandar",
      fileReader(new Map([["/srv/bandar/install.json", text]])),
    );

    expect(state.kind === "reported" ? state.manifest.source : null).toBe("manual");
  });

  test("a read error other than a missing file is unreadable", () => {
    const reader = (): string => {
      const error: Error & { code?: string } = new Error("EACCES: permission denied");

      error.code = "EACCES";

      throw error;
    };

    const state = detectInstall("/srv/bandar", reader);

    expect(state.kind === "unknown" ? state.reason : "").toContain("permission denied");
  });
});

describe("registration", () => {
  test("update takes arguments so its flags reach the command", () => {
    const commands = new Commands();

    register(commands);

    const command = commands.all.find((candidate) => candidate.name === "update");

    expect(command?.takesArguments).toBe(true);
  });
});

describe("arguments", () => {
  test("--check and --archive parse", () => {
    expect(parseUpdateFlags(["--check"])).toEqual({
      kind: "run",
      flags: { check: true, archive: null },
    });
    expect(parseUpdateFlags(["--archive", "/tmp/bandar"])).toEqual({
      kind: "run",
      flags: { check: false, archive: "/tmp/bandar" },
    });
  });

  test("a stray flag and a bare --archive are rejected", () => {
    expect(parseUpdateFlags(["--force"])).toEqual({
      kind: "invalid",
      reason: "unknown option: --force",
    });
    expect(parseUpdateFlags(["--archive"])).toEqual({
      kind: "invalid",
      reason: "--archive needs a file path",
    });
  });
});

describe("versions and assets", () => {
  test("compareVersions orders releases", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe("newer");
    expect(compareVersions("0.1.0", "0.1.0")).toBe("same");
    expect(compareVersions("0.2.0", "0.1.9")).toBe("older");
    expect(compareVersions("0.1.0", "v0.1.0")).toBe("same");
    expect(compareVersions("0.1.0-rc.1", "0.1.0")).toBe("newer");
    expect(compareVersions("0.1.0", "0.1.0-rc.1")).toBe("older");
    expect(compareVersions("0.1.0", "nightly")).toBe("unknown");
  });

  test("releaseNames picks the platform artifact and its checksum", () => {
    expect(releaseNames("0.2.0", "linux", "x64")).toEqual({
      asset: "bandar-0.2.0-linux-x64",
      checksum: "bandar-0.2.0-linux-x64.sha256",
    });
    expect(releaseNames("0.2.0", "win32", "x64")).toEqual({
      asset: "bandar-0.2.0-windows-x64.exe",
      checksum: "bandar-0.2.0-windows-x64.exe.sha256",
    });
    expect(releaseNames("0.2.0", "darwin", "arm64")).toBeNull();
  });

  test("a token comes from the first non-blank variable", () => {
    expect(githubToken({})).toBeNull();
    expect(githubToken({ GH_TOKEN: "second", GITHUB_TOKEN: "third" })).toBe("second");
    expect(githubToken({ BANDAR_GITHUB_TOKEN: "first", GH_TOKEN: "second" })).toBe("first");
    expect(githubToken({ BANDAR_GITHUB_TOKEN: "  ", GITHUB_TOKEN: "third" })).toBe("third");
  });

  test("BANDAR_UPDATE_URL replaces the API base", () => {
    expect(apiBase({})).toBe("https://api.github.com");
    expect(apiBase({ BANDAR_UPDATE_URL: "" })).toBe("https://api.github.com");
    expect(latestReleaseUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/repos/falentio/bandar/releases/latest",
    );
    expect(latestReleaseUrl("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080/repos/falentio/bandar/releases/latest",
    );
  });

  test("a checksum line is its first token, lowercased", () => {
    expect(parseChecksum(`${"A".repeat(64)}  bandar-0.1.0-linux-x64\n`)).toBe("a".repeat(64));
    expect(parseChecksum("not a digest")).toBeNull();
  });
});

describe("update --check", () => {
  test("an older installed version is update-available", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: API_ENV,
      argv: ["--check"],
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest 0.2.0", "update-available"]);
  });

  test("the same version is up-to-date", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: API_ENV,
      argv: ["--check"],
      send: serving({ version: "0.1.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest 0.1.0", "up-to-date"]);
  });

  test("an unreachable feed reports unknown and exits 0", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: API_ENV,
      argv: ["--check"],
      send: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
  });

  test("a repository with no release reports unknown and exits 0", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: API_ENV,
      argv: ["--check"],
      send: async () => ({ status: 404, body: new Uint8Array() }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
  });

  test("a missing token names the variable and exits 1 without a request", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: {
        BANDAR_CONFIG_DIR: fixture.configDir,
        BANDAR_GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      },
      argv: ["--check"],
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
    expect(recorded.errors).toEqual(["a GitHub token is required: set BANDAR_GITHUB_TOKEN"]);
    expect(recorded.requests).toEqual([]);
  });
});

describe("bandar update", () => {
  test("an install-script copy is replaced with the verified release", async () => {
    const fixture = fixtureOf("install-script");
    const bytes = encode("new binary payload");
    const recorded = runOf(fixture, { env: API_ENV, send: serving({ version: "0.2.0", bytes }) });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual([`bandar 0.2.0 installed at ${fixture.target}`]);
    expect(decode(readFileSync(fixture.target))).toBe("new binary payload");
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755);
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
  });

  test("a manual copy may be replaced too", async () => {
    const fixture = fixtureOf("manual");
    const bytes = encode("new binary payload");
    const recorded = runOf(fixture, { env: API_ENV, send: serving({ version: "0.2.0", bytes }) });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(decode(readFileSync(fixture.target))).toBe("new binary payload");
  });

  test("an unknown source refuses in one line naming the installer", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toContain("install.sh");
    expect(recorded.lines).toEqual([]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(existsSync(join(fixture.configDir, "install.json"))).toBe(false);
    expect(recorded.requests).toEqual([]);
  });

  test("an unwritable target prints the sudo command and writes nothing", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      canWrite: false,
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual([
      `bandar: cannot write ${join(fixture.directory, "bin")}; run "sudo bandar update" to replace ${fixture.target}`,
    ]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(recorded.requests).toEqual([]);
  });

  test("a checksum mismatch leaves the binary alone and the temp file gone", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: serving({
        version: "0.2.0",
        bytes: encode("new binary payload"),
        checksum: "0".repeat(64),
      }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("checksum mismatch");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
  });

  test("the same version is a no-op with no download", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: serving({ version: "0.1.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["bandar 0.1.0 is up to date"]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(recorded.requests.map((request) => request.url)).toEqual([
      latestReleaseUrl("https://api.test"),
    ]);
  });

  test("a newer installed version is left alone", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      installed: "0.3.0",
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual([
      "bandar 0.3.0 is newer than the latest release 0.2.0; leaving it alone",
    ]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("a missing token stops before any request", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: {
        BANDAR_CONFIG_DIR: fixture.configDir,
        BANDAR_GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      },
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual(["a GitHub token is required: set BANDAR_GITHUB_TOKEN"]);
    expect(recorded.requests).toEqual([]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("an unusable config directory is refused with one line", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: { BANDAR_CONFIG_DIR: "relative/config" },
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toContain("BANDAR_CONFIG_DIR");
    expect(recorded.requests).toEqual([]);
  });

  test("a repository with no release yet fails with that reason", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: async () => ({ status: 404, body: new Uint8Array() }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual(["bandar: falentio/bandar has no published release yet"]);
  });

  test("an unsupported platform is refused by name", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      platform: "darwin",
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual([
      "bandar: bandar releases on linux and windows, not darwin-x64",
    ]);
  });

  test("a release without the matching asset is refused", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: serving({
        version: "0.2.0",
        bytes: encode("new"),
        assets: [{ name: "bandar-0.2.0-darwin-x64", url: "https://assets.test/other" }],
      }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("has no bandar-0.2.0-linux-x64");
  });

  test("the asset request asks for the octet stream", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      env: API_ENV,
      send: serving({ version: "0.2.0", bytes: encode("new") }),
    });

    await runUpdate(recorded.run);

    expect(recorded.requests.map((request) => request.accept)).toEqual([
      "application/vnd.github+json",
      "application/octet-stream",
      "application/octet-stream",
    ]);
  });
});

describe("bandar update --archive", () => {
  const archiveFixture = (): Fixture & { readonly archive: string } => {
    const fixture = fixtureOf("install-script");
    const archive = join(fixture.directory, "bandar-0.2.0-linux-x64");
    const bytes = encode("archived binary payload");

    writeFileSync(archive, bytes);
    writeFileSync(`${archive}.sha256`, `${sha256(bytes)}  bandar-0.2.0-linux-x64\n`);

    return { ...fixture, archive };
  };

  test("a local archive is verified and renamed into place without a token", async () => {
    const fixture = archiveFixture();

    const recorded = runOf(fixture, {
      env: { BANDAR_CONFIG_DIR: fixture.configDir },
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(decode(readFileSync(fixture.target))).toBe("archived binary payload");
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755);
    expect(recorded.requests).toEqual([]);
  });

  test("a mismatched archive is refused and the binary keeps its bytes", async () => {
    const fixture = archiveFixture();

    writeFileSync(`${fixture.archive}.sha256`, `${"0".repeat(64)}  bandar-0.2.0-linux-x64\n`);

    const recorded = runOf(fixture, {
      env: { BANDAR_CONFIG_DIR: fixture.configDir },
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("checksum mismatch");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
  });

  test("an archive without its checksum file is refused", async () => {
    const fixture = archiveFixture();

    rmSync(`${fixture.archive}.sha256`);

    const recorded = runOf(fixture, {
      env: { BANDAR_CONFIG_DIR: fixture.configDir },
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("could not read");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("an unknown source refuses an archive too", async () => {
    const fixture = archiveFixture();

    rmSync(join(fixture.configDir, "install.json"));

    const recorded = runOf(fixture, {
      env: { BANDAR_CONFIG_DIR: fixture.configDir },
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("install.sh");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("the databases stay untouched", async () => {
    const fixture = archiveFixture();
    const databases = join(fixture.directory, "data");

    mkdirSync(databases);
    writeFileSync(join(databases, "bandar.db"), "sqlite");
    writeFileSync(join(databases, "bandar.duckdb"), "duckdb");

    const recorded = runOf(fixture, {
      env: {
        BANDAR_CONFIG_DIR: fixture.configDir,
        BANDAR_DB: join(databases, "bandar.db"),
        BANDAR_DUCKDB: join(databases, "bandar.duckdb"),
      },
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(readFileSync(join(databases, "bandar.db"), "utf8")).toBe("sqlite");
    expect(readFileSync(join(databases, "bandar.duckdb"), "utf8")).toBe("duckdb");
  });
});
