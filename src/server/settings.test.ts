import { describe, expect, test } from "vite-plus/test";
import { loadSettings, settingsPath, settingsSchema, settingsSchemaPath } from "./settings";

const home = "/home/andrew/.bandar";

const path = settingsPath(home);

const readerOf = (text: string) => () => text;

const settingsFrom = (read: (path: string) => string): ReturnType<typeof loadSettings> =>
  loadSettings(home, { read, write: () => {} });

const reasonOf = (result: ReturnType<typeof loadSettings>): string => {
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
    expect(settingsFrom(missingFile)).toEqual({ kind: "missing", path });
  });

  test("any other read failure is invalid, carrying the error message", () => {
    const read = () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/srv/bandar/config.json'"), {
        code: "EACCES",
      });
    };

    const report = settingsFrom(read);

    expect(report).toHaveProperty("path", "/home/andrew/.bandar/config.json");
    expect(reasonOf(report)).toContain("EACCES: permission denied");
  });

  test("a file without a server section is ok", () => {
    expect(settingsFrom(readerOf("{}"))).toEqual({ kind: "ok", path, settings: {} });
  });

  test("a partial server section is ok", () => {
    expect(settingsFrom(readerOf('{"server":{"host":"127.0.0.1"}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { host: "127.0.0.1" } },
    });

    expect(settingsFrom(readerOf('{"server":{"port":4000}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { port: 4000 } },
    });
  });

  test("the host is trimmed", () => {
    expect(settingsFrom(readerOf('{"server":{"host":" 127.0.0.1 "}}'))).toEqual({
      kind: "ok",
      path,
      settings: { server: { host: "127.0.0.1" } },
    });
  });

  test("an auth URL is accepted, trimmed, and kept as written", () => {
    expect(
      settingsFrom(readerOf('{"server":{"authUrl":" https://llm.example.com/api "}}')),
    ).toEqual({
      kind: "ok",
      path,
      settings: { server: { authUrl: "https://llm.example.com/api" } },
    });
  });

  test("an auth URL that is not a URL is invalid", () => {
    for (const authUrl of ["alias", "", "llm.example.com"]) {
      const reason = reasonOf(
        settingsFrom(readerOf(`{"server":{"authUrl":${JSON.stringify(authUrl)}}}`)),
      );

      expect(reason).toContain("server.authUrl");
    }
  });

  test("an auth URL must be http or https", () => {
    for (const authUrl of ["javascript:alert(1)", "ftp://llm.example.com", "file:///srv/auth"]) {
      const reason = reasonOf(
        settingsFrom(readerOf(`{"server":{"authUrl":${JSON.stringify(authUrl)}}}`)),
      );

      expect(reason).toContain("server.authUrl");
      expect(reason).toContain("must be an http or https URL");
    }
  });

  test("a trusted origin stores as its URL origin", () => {
    expect(settingsFrom(readerOf('{"server":{"trustedOrigins":["https://X.COM/"]}}'))).toEqual({
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
        settingsFrom(readerOf(`{"server":{"trustedOrigins":[${JSON.stringify(origin)}]}}`)),
      );

      expect(reason).toContain("server.trustedOrigins.0");
      expect(reason).toContain("must be an origin");
    }
  });

  test("an empty trusted-origins list is invalid", () => {
    expect(reasonOf(settingsFrom(readerOf('{"server":{"trustedOrigins":[]}}')))).toContain(
      "server.trustedOrigins",
    );
  });

  test("a provider section parses the fields its kind has", () => {
    expect(
      settingsFrom(
        readerOf(
          '{"providers":{"kilocode":{"baseUrl":"https://kilo.example.test/api","catalogUrl":"https://kilo.example.test/models"},"nous":{"authUrl":"https://portal.example.test"}}}',
        ),
      ),
    ).toEqual({
      kind: "ok",
      path,
      settings: {
        providers: {
          kilocode: {
            baseUrl: "https://kilo.example.test/api",
            catalogUrl: "https://kilo.example.test/models",
          },
          nous: { authUrl: "https://portal.example.test" },
        },
      },
    });
  });

  test("an unknown provider kind or field is invalid", () => {
    expect(reasonOf(settingsFrom(readerOf('{"providers":{"nope":{}}}')))).toContain(
      "providers.nope",
    );
    expect(
      reasonOf(settingsFrom(readerOf('{"providers":{"kilocode":{"authUrl":"https://x.test"}}}'))),
    ).toContain("providers.kilocode.authUrl");
    expect(
      reasonOf(settingsFrom(readerOf('{"providers":{"hyper":{"catalogUrl":"https://x.test"}}}'))),
    ).toContain("providers.hyper.catalogUrl");
  });

  test("a provider URL must be http or https", () => {
    const reason = reasonOf(
      settingsFrom(readerOf('{"providers":{"tokenharbor":{"baseUrl":"ftp://x.test"}}}')),
    );

    expect(reason).toContain("providers.tokenharbor.baseUrl");
    expect(reason).toContain("must be an http or https URL");
  });

  test("a providers section that is not an object is invalid", () => {
    expect(reasonOf(settingsFrom(readerOf('{"providers":[]}')))).toContain("providers");
  });

  test("an unknown key is invalid at either level", () => {
    expect(reasonOf(settingsFrom(readerOf('{"nope":true}')))).toMatch(/^nope: Invalid key\b/u);
    expect(
      reasonOf(settingsFrom(readerOf('{"server":{"host":"127.0.0.1","proxied":true}}'))),
    ).toContain("server.proxied");
  });

  test("a port outside 0..65535, or not a whole number, is invalid", () => {
    for (const port of [-1, 70000, 80.5, "3000"]) {
      const reason = reasonOf(
        settingsFrom(readerOf(`{"server":{"port":${JSON.stringify(port)}}}`)),
      );

      expect(reason).toContain("server.port");
    }
  });

  test("an empty host is invalid", () => {
    for (const host of ["", "   "]) {
      const reason = reasonOf(
        settingsFrom(readerOf(`{"server":{"host":${JSON.stringify(host)}}}`)),
      );

      expect(reason).toContain("server.host");
    }
  });

  test("a root that is not an object is invalid", () => {
    for (const text of ["null", "42", '"server"', "[]"]) {
      expect(reasonOf(settingsFrom(readerOf(text)))).toMatch(/object/iu);
    }
  });

  test("a server section that is not an object is invalid", () => {
    expect(reasonOf(settingsFrom(readerOf('{"server":[]}')))).toContain("server");
  });

  test("malformed JSON is invalid", () => {
    expect(reasonOf(settingsFrom(readerOf('{"server":')))).toContain("JSON");
  });
});

describe("the schema beside the file", () => {
  const writesOf = (text: string): (readonly [string, string])[] => {
    const writes: (readonly [string, string])[] = [];

    loadSettings(home, {
      read: () => text,
      write: (target, body) => {
        writes.push([target, body]);
      },
    });

    return writes;
  };

  const rewritesOf = (text: string): (readonly [string, string])[] =>
    writesOf(text).filter(([target]) => target === path);

  test("the schema lands beside the settings on every read", () => {
    const [first, ...rest] = writesOf('{"$schema":"./config.schema.json"}');

    expect(first?.[0]).toBe(settingsSchemaPath(home));
    expect(JSON.parse(first?.[1] ?? "null")).toEqual(settingsSchema);
    expect(rest).toEqual([]);
    expect(settingsFrom(readerOf('{"$schema":"./config.schema.json"}'))).toEqual({
      kind: "ok",
      path,
      settings: { $schema: "./config.schema.json" },
    });
  });

  test("a file without $schema keeps every byte and gains the key", () => {
    const [rewrite] = rewritesOf('{"server":{"host":" 127.0.0.1 ","port":4000}}');

    expect(rewrite?.[0]).toBe(path);
    expect(rewrite?.[1]).toBe(
      '{"$schema": "./config.schema.json","server":{"host":" 127.0.0.1 ","port":4000}}',
    );
    expect(JSON.parse(rewrite?.[1] ?? "null")).toEqual({
      $schema: "./config.schema.json",
      server: { host: " 127.0.0.1 ", port: 4000 },
    });
  });

  test("the key holds the indent of the key that follows it", () => {
    const source = '{\n    "server": {\n        "port": 4000\n    }\n}\n';

    const [rewrite] = rewritesOf(source);

    expect(rewrite?.[1]).toBe(
      '{\n    "$schema": "./config.schema.json",\n    "server": {\n        "port": 4000\n    }\n}\n',
    );
  });

  test("an empty object gains the key and nothing else, with no trailing comma", () => {
    expect(rewritesOf("{}")[0]?.[1]).toBe('{"$schema": "./config.schema.json"}');
    expect(rewritesOf("{\n}\n")[0]?.[1]).toBe('{\n"$schema": "./config.schema.json"\n}\n');
  });

  test("a $schema the operator wrote is left alone", () => {
    const text = '{"$schema":"https://example.com/schema.json"}';

    expect(rewritesOf(text)).toEqual([]);
    expect(settingsFrom(readerOf(text))).toEqual({
      kind: "ok",
      path,
      settings: { $schema: "https://example.com/schema.json" },
    });
  });

  test("a file that already points at the schema is not rewritten", () => {
    const text = '{"$schema":"./config.schema.json","server":{"port":4000}}';

    expect(rewritesOf(text)).toEqual([]);
    expect(settingsFrom(readerOf(text))).toEqual({
      kind: "ok",
      path,
      settings: { $schema: "./config.schema.json", server: { port: 4000 } },
    });
  });

  test("an unknown key beside $schema still fails the boot", () => {
    const reason = reasonOf(
      settingsFrom(readerOf('{"$schema":"./config.schema.json","nope":true}')),
    );

    expect(reason).toMatch(/^nope: Invalid key\b/u);
  });

  test("a missing file writes the schema and nothing else", () => {
    const writes: (readonly [string, string])[] = [];

    const result = loadSettings(home, {
      read: missingFile,
      write: (target, body) => {
        writes.push([target, body]);
      },
    });

    expect(result.kind).toBe("missing");
    expect(writes.map(([target]) => target)).toEqual([settingsSchemaPath(home)]);
  });

  test("an unwritable directory still reads the settings", () => {
    const result = loadSettings(home, {
      read: readerOf('{"server":{"port":4000}}'),
      write: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    expect(result.kind).toBe("ok");
  });
});
