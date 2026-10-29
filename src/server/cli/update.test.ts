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
import { afterAll, describe, expect, test, vi } from "vite-plus/test";
import { Commands } from "./command";
import { detectInstall } from "./install-source";
import {
  assetHostAllowed,
  compareVersions,
  githubToken,
  latestTagUrl,
  parseChecksum,
  parseUpdateFlags,
  register,
  releaseAssetUrl,
  releaseNames,
  run,
  runUpdate,
  versionFromTagLocation,
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

const TOKEN = "stub-token";

const WEB = "https://web.test/falentio/bandar";
const API_FEED = "https://api.test/releases/latest";
const TAG_PAGE = latestTagUrl(WEB);

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
};

const fixtureOf = (source: string | null): Fixture => {
  const directory = workspace();
  const configDir = join(directory, "config");
  const target = join(directory, "bin", "bandar");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(target, "old binary");

  if (source !== null) writeFileSync(join(configDir, "install.json"), manifestText(source, target));

  return { directory, configDir, target };
};

type ServeOptions = {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly checksum?: string;
  readonly tagStatus?: number;
  readonly location?: string | null;
  readonly assetStatus?: number;
  readonly assets?: readonly { readonly name: string; readonly url: string }[];
};

const tagLocation = (version: string): string =>
  `https://web.test/falentio/bandar/releases/tag/v${version}`;

/** The anonymous flow: a redirect from the release page, then two asset downloads. */
const publicServing = (options: ServeOptions, platform = "linux"): HttpSend => {
  const names = releaseNames(options.version, platform, "x64");

  return async (url) => {
    if (url === TAG_PAGE) {
      const status = options.tagStatus ?? 302;

      if (status !== 302) return { status, body: new Uint8Array() };

      return {
        status,
        body: new Uint8Array(),
        location: options.location === undefined ? tagLocation(options.version) : options.location,
      };
    }

    if (names === null) return { status: 404, body: new Uint8Array() };

    if (url === releaseAssetUrl(WEB, options.version, names.asset))
      return { status: options.assetStatus ?? 200, body: options.bytes };

    if (url === releaseAssetUrl(WEB, options.version, names.checksum)) {
      const digest = options.checksum ?? sha256(options.bytes);

      return { status: 200, body: encode(`${digest}  ${names.asset}\n`) };
    }

    return { status: 404, body: new Uint8Array() };
  };
};

const apiRelease = (options: ServeOptions, platform: string): string => {
  const names = releaseNames(options.version, platform, "x64");

  if (names === null) throw new Error("the fixture platform has no asset");

  return JSON.stringify({
    tag_name: `v${options.version}`,
    assets: options.assets ?? [
      { name: names.asset, url: `https://api.test/assets/${names.asset}` },
      { name: names.checksum, url: `https://api.test/assets/${names.checksum}` },
    ],
  });
};

/** The private-fork flow: one JSON feed carrying the asset urls that need the token. */
const apiServing = (options: ServeOptions, platform = "linux"): HttpSend => {
  const names = releaseNames(options.version, platform, "x64");

  return async (url) => {
    if (url === API_FEED)
      return { status: options.tagStatus ?? 200, body: encode(apiRelease(options, platform)) };

    if (names !== null && url === `https://api.test/assets/${names.asset}`)
      return { status: options.assetStatus ?? 200, body: options.bytes };

    if (names !== null && url === `https://api.test/assets/${names.checksum}`) {
      const digest = options.checksum ?? sha256(options.bytes);

      return { status: 200, body: encode(`${digest}  ${names.asset}\n`) };
    }

    return { status: 404, body: new Uint8Array() };
  };
};

const PUBLIC_UPDATE = { webUrl: WEB, apiUrl: null };
const API_UPDATE = { webUrl: WEB, apiUrl: API_FEED };
const TOKEN_ENV = { BANDAR_GITHUB_TOKEN: TOKEN };

type Request = {
  readonly url: string;
  readonly accept: string | undefined;
  readonly authorization: string | undefined;
  readonly redirect: "follow" | "manual";
};

type Recorded = {
  readonly run: UpdateRun;
  readonly lines: string[];
  readonly errors: string[];
  readonly requests: Request[];
};

type RunOptions = {
  readonly update?: UpdateRun["update"];
  readonly env?: Record<string, string | undefined>;
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

  const recording: HttpSend = async (url, headers, redirect = "follow") => {
    requests.push({ url, accept: headers.Accept, authorization: headers.Authorization, redirect });

    return send(url, headers, redirect);
  };

  return {
    lines,
    errors,
    requests,
    run: {
      configDir: fixture.configDir,
      update: options.update ?? PUBLIC_UPDATE,
      env: options.env ?? {},
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

const tempFilesIn = (directory: string): readonly string[] =>
  readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));

const authorizations = (requests: readonly Request[]): readonly (string | undefined)[] =>
  requests.map((request) => request.authorization);

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

  test("the tag and asset URLs hang off the release web base", () => {
    expect(latestTagUrl("http://127.0.0.1:8080/bandar")).toBe(
      "http://127.0.0.1:8080/bandar/releases/latest",
    );
    expect(latestTagUrl("http://127.0.0.1:8080/bandar/")).toBe(
      "http://127.0.0.1:8080/bandar/releases/latest",
    );
    expect(
      releaseAssetUrl("http://127.0.0.1:8080/bandar/", "0.2.0", "bandar-0.2.0-linux-x64"),
    ).toBe("http://127.0.0.1:8080/bandar/releases/download/v0.2.0/bandar-0.2.0-linux-x64");
  });

  test("the latest tag comes from the redirect Location", () => {
    const requested = latestTagUrl(WEB);

    expect(versionFromTagLocation(tagLocation("0.2.0"), requested)).toBe("0.2.0");
    expect(versionFromTagLocation("/falentio/bandar/releases/tag/v0.2.0", requested)).toBe("0.2.0");
    expect(
      versionFromTagLocation("https://github.com/falentio/bandar/releases/tag/0.2.0", requested),
    ).toBe("0.2.0");
    expect(
      versionFromTagLocation("https://web.test/falentio/bandar/releases/tag/v0.2.0/", requested),
    ).toBe("0.2.0");
    expect(
      versionFromTagLocation("https://web.test/falentio/bandar/releases", requested),
    ).toBeNull();
    expect(
      versionFromTagLocation("https://web.test/falentio/bandar/releases/tag/nightly", requested),
    ).toBeNull();
    expect(versionFromTagLocation("", requested)).toBeNull();
    expect(versionFromTagLocation(null, requested)).toBeNull();
    expect(versionFromTagLocation(undefined, requested)).toBeNull();
  });

  test("the public asset hosts are trusted, and an unknown host is not", () => {
    expect(assetHostAllowed("https://api.github.com/x", "https://api.github.com")).toBe(true);
    expect(assetHostAllowed("https://github.com/x", "https://api.github.com")).toBe(true);
    expect(assetHostAllowed("https://release-assets.githubusercontent.com/x", API_FEED)).toBe(true);
    expect(assetHostAllowed("https://objects.githubusercontent.com/x", API_FEED)).toBe(true);
    expect(assetHostAllowed("https://api.test/assets/x", API_FEED)).toBe(true);
    expect(assetHostAllowed("https://evil.test/x", API_FEED)).toBe(false);
    expect(assetHostAllowed("https://api.github.com.evil.test/x", "https://api.github.com")).toBe(
      false,
    );
    expect(assetHostAllowed("not a url", "https://api.github.com")).toBe(false);
  });

  test("a checksum line is its first token, lowercased", () => {
    expect(parseChecksum(`${"A".repeat(64)}  bandar-0.1.0-linux-x64\n`)).toBe("a".repeat(64));
    expect(parseChecksum("not a digest")).toBeNull();
  });
});

describe("update --check", () => {
  test("the anonymous flow reports an available update without a token", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest 0.2.0", "update-available"]);
    expect(recorded.errors).toEqual([]);
    expect(authorizations(recorded.requests)).toEqual([undefined]);
    expect(recorded.requests[0]?.redirect).toBe("manual");
  });

  test("the same version is up-to-date", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: publicServing({ version: "0.1.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest 0.1.0", "up-to-date"]);
  });

  test("a release page that does not redirect exits 1", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: publicServing({ version: "0.2.0", bytes: encode("new"), tagStatus: 500 }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
    expect(recorded.errors).toEqual([
      "bandar: the release page answered HTTP 500, not a redirect to the latest tag",
    ]);
  });

  test("a redirect that is not a version tag exits 1", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: publicServing({
        version: "0.2.0",
        bytes: encode("new"),
        location: "https://web.test/falentio/bandar/releases",
      }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("which is not a version tag");
  });

  test("an unreachable release page reports unknown and exits 1", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
    expect(recorded.errors).toEqual([
      "bandar: could not read the release feed: connect ECONNREFUSED",
    ]);
  });

  test("a repository with no release reports unknown and exits 0", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      argv: ["--check"],
      send: async () => ({ status: 404, body: new Uint8Array() }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
  });

  test("the API override without a token names the variable and sends nothing", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: {
        BANDAR_GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      },
      argv: ["--check"],
      send: apiServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
    expect(recorded.errors).toEqual([
      "bandar: update.apiUrl reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN",
    ]);
    expect(recorded.requests).toEqual([]);
  });

  test("the API override with a token reports the feed version", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: TOKEN_ENV,
      argv: ["--check"],
      send: apiServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest 0.2.0", "update-available"]);
    expect(authorizations(recorded.requests)).toEqual([`Bearer ${TOKEN}`]);
    expect(recorded.requests[0]?.url).toBe(API_FEED);
  });

  test("a malformed API body exits 1", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: TOKEN_ENV,
      argv: ["--check"],
      send: async () => ({ status: 200, body: encode('{"tag_name":"v0.2.0"}') }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.lines).toEqual(["installed 0.1.0", "latest unknown", "unknown"]);
    expect(recorded.errors[0]).toContain("the release feed sent an unexpected body");
  });

  test("an API feed that answers HTTP 500 exits 1", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: TOKEN_ENV,
      argv: ["--check"],
      send: async () => ({ status: 500, body: new Uint8Array() }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual(["bandar: the release feed answered HTTP 500"]);
  });
});

describe("bandar update", () => {
  test("an anonymous install-script copy is replaced with the verified release", async () => {
    const fixture = fixtureOf("install-script");
    const bytes = encode("new binary payload");

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.2.0", bytes }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual([`bandar 0.2.0 installed at ${fixture.target}`]);
    expect(decode(readFileSync(fixture.target))).toBe("new binary payload");
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755);
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
    expect(authorizations(recorded.requests)).toEqual([undefined, undefined, undefined]);
    expect(recorded.requests.map((request) => request.url)).toEqual([
      TAG_PAGE,
      releaseAssetUrl(WEB, "0.2.0", "bandar-0.2.0-linux-x64"),
      releaseAssetUrl(WEB, "0.2.0", "bandar-0.2.0-linux-x64.sha256"),
    ]);
  });

  test("a manual copy may be replaced too", async () => {
    const fixture = fixtureOf("manual");
    const bytes = encode("new binary payload");

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.2.0", bytes }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(decode(readFileSync(fixture.target))).toBe("new binary payload");
  });

  test("an unknown source refuses in one line naming the npm install first", async () => {
    const fixture = fixtureOf(null);

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toContain('"npm install -g bandar@latest"');
    expect(recorded.errors[0]).toContain("install.sh");
    expect(recorded.errors[0].indexOf("bandar@latest")).toBeLessThan(
      recorded.errors[0].indexOf("install.sh"),
    );
    expect(recorded.lines).toEqual([]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(existsSync(join(fixture.configDir, "install.json"))).toBe(false);
    expect(recorded.requests).toEqual([]);
  });

  test("an unwritable target prints the sudo command and writes nothing", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      canWrite: false,
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
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
      send: publicServing({
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

  test("a missing checksum sibling refuses the update", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.2.0", bytes: encode("new"), assetStatus: 404 }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("could not download bandar-0.2.0-linux-x64");
    expect(recorded.errors[0]).toContain("HTTP 404");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("a failed rename on Windows names the locked executable", async () => {
    const fixture = fixtureOf("install-script");
    const target = join(fixture.directory, "bin", "bandar.d");

    mkdirSync(target);
    writeFileSync(
      join(fixture.configDir, "install.json"),
      JSON.stringify({ source: "install-script", version: "0.1.0", path: target }),
    );

    const recorded = runOf(fixture, {
      platform: "win32",
      send: publicServing({ version: "0.2.0", bytes: encode("new") }, "win32"),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("Windows locks a running executable");
    expect(recorded.errors[0]).toContain("run the installer again");
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
  });

  test("a failed rename elsewhere reports the failure", async () => {
    const fixture = fixtureOf("install-script");
    const target = join(fixture.directory, "bin", "bandar.d");

    mkdirSync(target);
    writeFileSync(
      join(fixture.configDir, "install.json"),
      JSON.stringify({ source: "install-script", version: "0.1.0", path: target }),
    );

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("could not replace");
    expect(tempFilesIn(join(fixture.directory, "bin"))).toEqual([]);
  });

  test("the same version is a no-op that never fetches an asset", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      send: publicServing({ version: "0.1.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual(["bandar 0.1.0 is up to date"]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
    expect(recorded.requests.map((request) => request.url)).toEqual([TAG_PAGE]);
  });

  test("a newer installed version is left alone", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      installed: "0.3.0",
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(recorded.lines).toEqual([
      "bandar 0.3.0 is newer than the latest release 0.2.0; leaving it alone",
    ]);
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });

  test("a repository with no release yet fails with that reason", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      send: async () => ({ status: 404, body: new Uint8Array() }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual(["bandar: falentio/bandar has no published release yet"]);
  });

  test("an unusable environment is refused with one line", async () => {
    const errors: string[] = [];

    const error = vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });

    try {
      expect(await run(["--check"], { BANDAR_CONFIG_DIR: "relative/config" })).toBe(1);
    } finally {
      error.mockRestore();
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("BANDAR_CONFIG_DIR");
  });

  test("an unsupported platform is refused by name", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      platform: "darwin",
      send: publicServing({ version: "0.2.0", bytes: encode("new") }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors).toEqual([
      "bandar: bandar releases on linux and windows, not darwin-x64",
    ]);
  });

  test("the API override replaces the binary with the token on one host only", async () => {
    const fixture = fixtureOf("install-script");
    const bytes = encode("private fork payload");

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: TOKEN_ENV,
      send: apiServing({ version: "0.2.0", bytes }),
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(decode(readFileSync(fixture.target))).toBe("private fork payload");
    expect(recorded.requests.map((request) => request.url)).toEqual([
      API_FEED,
      "https://api.test/assets/bandar-0.2.0-linux-x64",
      "https://api.test/assets/bandar-0.2.0-linux-x64.sha256",
    ]);
    expect(recorded.requests.map((request) => request.accept)).toEqual([
      "application/vnd.github+json",
      "application/octet-stream",
      "application/octet-stream",
    ]);
    expect(authorizations(recorded.requests)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
  });

  test("the API override refuses a release without the matching asset", async () => {
    const fixture = fixtureOf("install-script");

    const recorded = runOf(fixture, {
      update: API_UPDATE,
      env: TOKEN_ENV,
      send: apiServing({
        version: "0.2.0",
        bytes: encode("new"),
        assets: [{ name: "bandar-0.2.0-darwin-x64", url: "https://api.test/assets/other" }],
      }),
    });

    expect(await runUpdate(recorded.run)).toBe(1);
    expect(recorded.errors[0]).toContain("publishes no bandar-0.2.0-linux-x64 asset");
    expect(decode(readFileSync(fixture.target))).toBe("old binary");
  });
});

test("a foreign asset host is refused before any request, so the token stays put", async () => {
  const fixture = fixtureOf("install-script");
  const names = releaseNames("0.2.0", "linux", "x64");

  if (names === null) throw new Error("the fixture platform has no asset");

  const recorded = runOf(fixture, {
    update: API_UPDATE,
    env: TOKEN_ENV,
    send: async (url) => {
      if (url === API_FEED)
        return {
          status: 200,
          body: encode(
            JSON.stringify({
              tag_name: "v0.2.0",
              assets: [
                { name: names.asset, url: "https://evil.test/bandar" },
                { name: names.checksum, url: "https://evil.test/bandar.sha256" },
              ],
            }),
          ),
        };

      return { status: 200, body: encode("unreachable") };
    },
  });

  expect(await runUpdate(recorded.run)).toBe(1);
  expect(recorded.errors[0]).toContain("evil.test is not an allowed asset host");
  expect(recorded.requests.map((request) => request.url)).toEqual([API_FEED]);
  expect(decode(readFileSync(fixture.target))).toBe("old binary");
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
      argv: ["--archive", fixture.archive],
    });

    expect(await runUpdate(recorded.run)).toBe(0);
    expect(readFileSync(join(databases, "bandar.db"), "utf8")).toBe("sqlite");
    expect(readFileSync(join(databases, "bandar.duckdb"), "utf8")).toBe("duckdb");
  });
});
