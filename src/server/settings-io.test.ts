import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { settingsIo } from "./settings-io";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bandar-settings-io-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the settings io", () => {
  test("a write creates the data directory, so a fresh home gets the file", () => {
    const path = join(home, "fresh", "bandar", "config.schema.json");

    settingsIo.write(path, "{}\n");

    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  test("a write replaces the previous bytes whole", () => {
    const path = join(home, "config.json");

    writeFileSync(path, '{"server":{"port":4000}}');
    settingsIo.write(path, '{"$schema":"./config.schema.json"}\n');

    expect(readFileSync(path, "utf8")).toBe('{"$schema":"./config.schema.json"}\n');
  });

  test("a write that cannot land leaves the target alone and no temp file behind", () => {
    const path = join(home, "config.json");

    mkdirSync(path);

    expect(() => settingsIo.write(path, "{}\n")).toThrow();
    expect(readdirSync(home)).toEqual(["config.json"]);
  });
});
