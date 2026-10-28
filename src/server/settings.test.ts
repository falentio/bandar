import { describe, expect, test } from "vite-plus/test";
import { readSettings, settingsPath } from "./settings";

const home = "/home/andrew/.bandar";

const path = settingsPath(home);

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

  test("a missing file reads as missing, naming the path", () => {
    expect(readSettings(home, missingFile)).toEqual({ kind: "missing", path });
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
    expect(readSettings(home, readerOf("{}"))).toEqual({ kind: "ok", path, settings: {} });
  });

  test("a partial server section is ok", () => {
    expect(readSettings(home, readerOf('{"server":{"host":"127.0.0.1"}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { host: "127.0.0.1" } },
    });

    expect(readSettings(home, readerOf('{"server":{"port":4000}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { port: 4000 } },
    });
  });

  test("the host is trimmed", () => {
    expect(readSettings(home, readerOf('{"server":{"host":" 127.0.0.1 "}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { host: "127.0.0.1" } },
    });
  });

  test("an auth URL is accepted, trimmed, and kept as written", () => {
    expect(
      readSettings(home, readerOf('{"server":{"authUrl":" https://llm.example.com/api "}}')),
    ).toEqual({
      kind: "ok",
      path,
      settings: { server: { authUrl: "https://llm.example.com/api" } },
    });
  });

  test("an auth URL that is not a URL is invalid", () => {
    for (const authUrl of ["alias", "", "llm.example.com"]) {
      const reason = reasonOf(
        readSettings(home, readerOf(`{"server":{"authUrl":${JSON.stringify(authUrl)}}}`)),
      );

      expect(reason).toContain("server.authUrl");
    }
  });

  test("an auth URL must be http or https", () => {
    for (const authUrl of ["javascript:alert(1)", "ftp://llm.example.com", "file:///srv/auth"]) {
      const reason = reasonOf(
        readSettings(home, readerOf(`{"server":{"authUrl":${JSON.stringify(authUrl)}}}`)),
      );

      expect(reason).toContain("server.authUrl");
      expect(reason).toContain("must be an http or https URL");
    }
  });

  test("a trusted origin stores as its URL origin", () => {
    expect(
      readSettings(home, readerOf('{"server":{"trustedOrigins":["https://X.COM/"]}}')),
    ).toEqual({
      kind: "ok",
      path,
      settings: { server: { trustedOrigins: ["https://x.com"] } },
    });
  });

  test("a trusted origin with a path, a query, a fragment, or credentials is invalid", () => {
    for (const origin of [
      "https://llm.example.com/api",
      "https://llm.example.com?tenant=acme",
      "https://llm.example.com#top",
      "https://user:secret@llm.example.com",
    ]) {
      const reason = reasonOf(
        readSettings(home, readerOf(`{"server":{"trustedOrigins":[${JSON.stringify(origin)}]}}`)),
      );

      expect(reason).toContain("server.trustedOrigins.0");
      expect(reason).toContain("must be an origin");
    }
  });

  test("an empty trusted-origins list is invalid", () => {
    expect(reasonOf(readSettings(home, readerOf('{"server":{"trustedOrigins":[]}}')))).toContain(
      "server.trustedOrigins",
    );
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
