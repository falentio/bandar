import { describe, expect, test } from "vite-plus/test";
import { readSettings, settingsPath } from "./settings";

const home = "/home/andrew/.bandar";

const readerOf = (text: string) => () => text;

const reasonOf = (result: ReturnType<typeof readSettings>): string => {
  if (result.kind !== "invalid") throw new Error(`expected invalid, got ${result.kind}`);

  return result.reason;
};

const missingFile = (): string => {
  throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
};

describe("settings", () => {
  test("the settings path appends config.json to the home directory", () => {
    expect(settingsPath(home)).toBe("/home/andrew/.bandar/config.json");
  });

  test("a missing file reads as missing", () => {
    expect(readSettings(home, missingFile)).toEqual({ kind: "missing" });
  });

  test("any other read failure is invalid, carrying the error message", () => {
    const read = () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/srv/bandar/config.json'"), {
        code: "EACCES",
      });
    };

    const report = readSettings(home, read);

    expect(report).toHaveProperty("path", "/home/andrew/.bandar/config.json");
    expect(reasonOf(report)).toContain("EACCES: permission denied");
  });

  test("a file without a server section is ok", () => {
    expect(readSettings(home, readerOf("{}"))).toEqual({ kind: "ok", settings: {} });
  });

  test("a partial server section is ok", () => {
    expect(readSettings(home, readerOf('{"server":{"host":"127.0.0.1"}}'))).toEqual({
      kind: "ok",
      settings: { server: { host: "127.0.0.1" } },
    });

    expect(readSettings(home, readerOf('{"server":{"port":4000}}'))).toEqual({
      kind: "ok",
      settings: { server: { port: 4000 } },
    });
  });

  test("the host is trimmed", () => {
    expect(readSettings(home, readerOf('{"server":{"host":" 127.0.0.1 "}}'))).toEqual({
      kind: "ok",
      settings: { server: { host: "127.0.0.1" } },
    });
  });

  test("an unknown key is invalid at either level", () => {
    expect(reasonOf(readSettings(home, readerOf('{"nope":true}')))).toMatch(
      /^nope: Invalid key\b/u,
    );
    expect(
      reasonOf(readSettings(home, readerOf('{"server":{"host":"127.0.0.1","proxied":true}}'))),
    ).toContain("server.proxied");
  });

  test("a port outside 0..65535, or not a whole number, is invalid", () => {
    for (const port of [-1, 70000, 80.5, "3000"]) {
      const reason = reasonOf(
        readSettings(home, readerOf(`{"server":{"port":${JSON.stringify(port)}}}`)),
      );

      expect(reason).toContain("server.port");
    }
  });

  test("an empty host is invalid", () => {
    for (const host of ["", "   "]) {
      const reason = reasonOf(
        readSettings(home, readerOf(`{"server":{"host":${JSON.stringify(host)}}}`)),
      );

      expect(reason).toContain("server.host");
    }
  });

  test("a root that is not an object is invalid", () => {
    for (const text of ["null", "42", '"server"', "[]"]) {
      expect(reasonOf(readSettings(home, readerOf(text)))).toMatch(/object/iu);
    }
  });

  test("a server section that is not an object is invalid", () => {
    expect(reasonOf(readSettings(home, readerOf('{"server":[]}')))).toContain("server");
  });

  test("malformed JSON is invalid", () => {
    expect(reasonOf(readSettings(home, readerOf('{"server":')))).toContain("JSON");
  });
});
