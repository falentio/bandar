import { describe, expect, test } from "vite-plus/test";
import { installManifestPath, readInstallManifest } from "./install";

const configDir = "/srv/bandar";

const manifestText = (overrides: Record<string, string>): string =>
  JSON.stringify({
    source: "install-script",
    version: "0.1.0",
    path: "/usr/local/bin/bandar",
    ...overrides,
  });

const readerOf = (text: string) => () => text;

const reasonOf = (result: ReturnType<typeof readInstallManifest>): string => {
  if (result.kind !== "invalid") throw new Error(`expected invalid, got ${result.kind}`);

  return result.reason;
};

describe("install manifest", () => {
  test("the manifest path appends install.json to the config dir", () => {
    expect(installManifestPath(configDir)).toBe("/srv/bandar/install.json");
    expect(installManifestPath("/srv/bandar/")).toBe("/srv/bandar/install.json");
    expect(installManifestPath("C:\\Users\\bandar\\.config\\bandar")).toBe(
      "C:\\Users\\bandar\\.config\\bandar/install.json",
    );
  });

  test("a valid manifest parses", () => {
    const manifest = readInstallManifest(configDir, readerOf(manifestText({})));

    expect(manifest).toEqual({
      kind: "ok",
      manifest: {
        source: "install-script",
        version: "0.1.0",
        path: "/usr/local/bin/bandar",
      },
    });
  });

  test("the reader is asked for the manifest path", () => {
    const asked: string[] = [];

    readInstallManifest(configDir, (path) => {
      asked.push(path);

      return manifestText({});
    });

    expect(asked).toEqual(["/srv/bandar/install.json"]);
  });

  test("a missing file reads as missing", () => {
    const read = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };

    expect(readInstallManifest(configDir, read)).toEqual({ kind: "missing" });
  });

  test("malformed JSON is invalid", () => {
    expect(reasonOf(readInstallManifest(configDir, readerOf('{"source":')))).toContain("JSON");
  });

  test("a relative binary path is invalid", () => {
    const result = readInstallManifest(configDir, readerOf(manifestText({ path: "bandar" })));

    expect(reasonOf(result)).toContain("path: must be an absolute path");
  });

  test("an unknown source is invalid", () => {
    const result = readInstallManifest(configDir, readerOf(manifestText({ source: "apt" })));

    expect(reasonOf(result)).toContain("source");
  });
});
