import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_API_PORT, DEV_WEB_PORT } from "../shared/topology";
import {
  ConfigError,
  detectRunMode,
  loadConfig,
  loadConfigReport,
  parseConfig,
  warnIfAuthSecretUnset,
  type ConfigReport,
  type ConfigSource,
  type RunMode,
} from "./config";
import type { TailnetIdentity, TailnetLookup } from "./tailnet";

const MODE_HOMES = [
  ["development", ".bandar_dev"],
  ["production", ".bandar"],
] as const;

const home = "/srv/bandar";

const ioOf = (read: (path: string) => string) => ({ read, write: () => {} });

const missingFile = (): string => {
  throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
};

const noDiscovery: TailnetLookup = () => {
  throw new Error("discovery ran with server.tailscale off");
};

const reportOf = (
  env: Record<string, string | undefined> = {},
  mode: RunMode = "production",
  json = "{}",
  lookup: TailnetLookup = noDiscovery,
) =>
  loadConfigReport(
    { BANDAR_HOME: home, BANDAR_AUTH_SECRET: "set", ...env },
    ioOf(() => json),
    mode,
    lookup,
  );

const fromFile = (json: string, env: Record<string, string | undefined> = {}) =>
  loadConfig(
    { BANDAR_HOME: home, ...env },
    ioOf(() => json),
    "production",
  );

const sourcesOf = (report: ConfigReport, prefix = "server."): Record<string, ConfigSource> =>
  Object.fromEntries(
    report.rows.filter((row) => row.key.startsWith(prefix)).map((row) => [row.key, row.source]),
  );

describe("config", () => {
  test("a provider origin that is not a URL fails at boot, naming the settings key", () => {
    for (const [name, key] of [
      ["BANDAR_KILOCODE_API", "providers.kilocode.baseUrl"],
      ["BANDAR_KILOCODE_MODELS_URL", "providers.kilocode.catalogUrl"],
      ["BANDAR_TOKENHARBOR_API", "providers.tokenharbor.baseUrl"],
      ["BANDAR_YETA_API", "providers.yeta.baseUrl"],
      ["BANDAR_RIVER_API", "providers.river.baseUrl"],
      ["BANDAR_RIVER_PRICING_URL", "providers.river.catalogUrl"],
      ["BANDAR_NOUS_API", "providers.nous.baseUrl"],
      ["BANDAR_NOUS_PORTAL", "providers.nous.authUrl"],
      ["BANDAR_HYPER_API", "providers.hyper.baseUrl"],
      ["BANDAR_OPENCODE_API", "providers.opencode.baseUrl"],
      ["BANDAR_ZRO_API", "providers.zro.baseUrl"],
    ] as const) {
      const attempt = () => parseConfig({ [name]: "hyper.local" });

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(key);
      expect(attempt).toThrow(name);
    }
  });

  test("a provider origin pointing at a fake passes", () => {
    const config = parseConfig({
      BANDAR_HYPER_API: "http://127.0.0.1:9/hyper",
      BANDAR_NOUS_PORTAL: "https://portal.example.test",
    });

    expect(config.port).toBeGreaterThan(0);
  });

  test("a non-http BANDAR_AUTH_URL fails at boot", () => {
    const attempt = () => parseConfig({ BANDAR_AUTH_URL: "javascript:alert(1)" });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("BANDAR_AUTH_URL");
    expect(attempt).toThrow("must be an http or https URL");
  });

  test("BANDAR_CONFIG_DIR defaults under the home directory", () => {
    expect(parseConfig({}).configDir).toBe(join(homedir(), ".config", "bandar"));
  });

  test("BANDAR_CONFIG_DIR is used as given", () => {
    expect(parseConfig({ BANDAR_CONFIG_DIR: "/srv/bandar" }).configDir).toBe("/srv/bandar");
  });

  test("a blank or relative BANDAR_CONFIG_DIR fails at boot", () => {
    for (const value of ["", "bandar", ".config/bandar"]) {
      const attempt = () => parseConfig({ BANDAR_CONFIG_DIR: value });

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow("BANDAR_CONFIG_DIR: must be an absolute path");
    }
  });

  test("BANDAR_HOME defaults both databases under the run mode's home directory", () => {
    for (const [mode, directory] of MODE_HOMES) {
      const config = parseConfig({}, mode);

      expect(config.databasePath).toBe(join(homedir(), directory, "bandar.db"));
      expect(config.duckdbPath).toBe(join(homedir(), directory, "bandar.duckdb"));
    }
  });

  test("detectRunMode reports development under the test runner", () => {
    expect(detectRunMode(), "the test runner is not a compiled binary").toBe("development");
  });

  test("parseConfig without a mode takes the home directory of the detected run mode", () => {
    expect(parseConfig({}).databasePath).toBe(join(homedir(), ".bandar_dev", "bandar.db"));
  });

  test("an explicit BANDAR_HOME overrides the run mode default", () => {
    for (const [mode] of MODE_HOMES) {
      const config = parseConfig({ BANDAR_HOME: "/srv/bandar" }, mode);

      expect(config.databasePath).toBe("/srv/bandar/bandar.db");
      expect(config.duckdbPath).toBe("/srv/bandar/bandar.duckdb");
    }
  });

  test("BANDAR_DB and BANDAR_DUCKDB no longer move a database", () => {
    const config = parseConfig(
      {
        BANDAR_HOME: "/srv/bandar",
        BANDAR_DB: "/data/x.db",
        BANDAR_DUCKDB: "/data/x.duckdb",
      },
      "production",
    );

    expect(config.databasePath).toBe("/srv/bandar/bandar.db");
    expect(config.duckdbPath).toBe("/srv/bandar/bandar.duckdb");
  });

  test("a blank or relative BANDAR_HOME fails at boot", () => {
    for (const value of ["", "srv/bandar", ".bandar"]) {
      const attempt = () => parseConfig({ BANDAR_HOME: value });

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow("BANDAR_HOME: must be an absolute path");
    }
  });
});

describe("the settings file", () => {
  const file = JSON.stringify({ server: { host: "127.0.0.1", port: 4000 } });

  test("the file supplies the host and the port", () => {
    const config = fromFile(file);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.authUrl).toBe("http://localhost:4000");
  });

  test("the file overrides the environment", () => {
    const config = fromFile(file, { BANDAR_HOST: "10.0.0.5", BANDAR_PORT: "5000" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
  });

  test("the environment stands in for a key the file leaves out", () => {
    const config = fromFile(JSON.stringify({ server: { port: 4000 } }), {
      BANDAR_HOST: "10.0.0.5",
      BANDAR_AUTH_URL: "https://env.example.com",
    });

    expect(config.host).toBe("10.0.0.5");
    expect(config.authUrl).toBe("https://env.example.com");
  });

  test("a blank environment value falls through to the file", () => {
    const config = fromFile(file, { BANDAR_HOST: "", BANDAR_PORT: "" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
  });

  test("the file supplies the auth URL and the trusted origins", () => {
    const config = fromFile(
      JSON.stringify({
        server: {
          authUrl: "https://llm.example.com",
          trustedOrigins: ["https://LLM.example.com/", "https://alt.example.com"],
        },
      }),
    );

    expect(config.authUrl).toBe("https://llm.example.com");
    expect(config.trustedOrigins).toEqual(["https://llm.example.com", "https://alt.example.com"]);
  });

  test("the file overrides the environment for the auth URL and the trusted origins", () => {
    const config = fromFile(
      JSON.stringify({
        server: {
          authUrl: "https://file.example.com",
          trustedOrigins: ["https://file.example.com"],
        },
      }),
      {
        BANDAR_AUTH_URL: "https://env.example.com",
        BANDAR_TRUSTED_ORIGINS: "https://one.example.com, https://two.example.com",
      },
    );

    expect(config.authUrl).toBe("https://file.example.com");
    expect(config.trustedOrigins).toEqual(["https://file.example.com"]);
  });

  test("the environment trusted origins stand in when the file has none", () => {
    const config = fromFile(JSON.stringify({ server: {} }), {
      BANDAR_TRUSTED_ORIGINS: " https://one.example.com/ , https://TWO.example.com ,",
    });

    expect(config.trustedOrigins).toEqual(["https://one.example.com", "https://two.example.com"]);
  });

  test("an environment origin with a path fails the boot, naming the variable and the value", () => {
    const origin = "https://llm.example.com/api";
    const attempt = () => fromFile("{}", { BANDAR_TRUSTED_ORIGINS: origin });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(`BANDAR_TRUSTED_ORIGINS: ${origin}`);
    expect(attempt).toThrow("must be an origin");
  });

  test("an environment entry that is not a URL fails the boot, naming the variable and the value", () => {
    const attempt = () =>
      fromFile("{}", { BANDAR_TRUSTED_ORIGINS: "https://one.example.com, local" });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("BANDAR_TRUSTED_ORIGINS: local");
  });

  test("an environment origin that is not http or https fails the boot", () => {
    const attempt = () => fromFile("{}", { BANDAR_TRUSTED_ORIGINS: "javascript:alert(1)" });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("must be an http or https URL");
  });

  test("an environment list with no entries fails the boot", () => {
    const attempt = () => fromFile("{}", { BANDAR_TRUSTED_ORIGINS: " , " });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("BANDAR_TRUSTED_ORIGINS: needs at least one origin");
  });

  test("loadConfig reads config.json under BANDAR_HOME", () => {
    const asked: string[] = [];

    loadConfig(
      { BANDAR_HOME: home },
      ioOf((path) => {
        asked.push(path);

        return "{}";
      }),
    );

    expect(asked).toEqual(["/srv/bandar/config.json"]);
  });

  test("a missing file leaves the defaults", () => {
    const config = loadConfig({ BANDAR_HOME: home }, ioOf(missingFile));

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(DEFAULT_API_PORT);
  });

  test("an invalid file fails the boot, naming the file and the field", () => {
    const attempt = () =>
      loadConfig(
        { BANDAR_HOME: home },
        ioOf(() => '{"server":{"port":70000}}'),
      );

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("invalid configuration");
    expect(attempt).toThrow("/srv/bandar/config.json: server.port");
  });

  test("a blank BANDAR_HOME fails before the file is read", () => {
    const attempt = () => loadConfig({ BANDAR_HOME: "" }, ioOf(missingFile));

    expect(attempt).toThrow("BANDAR_HOME: must be an absolute path");
  });

  test("a rejected environment touches nothing in the data directory", () => {
    const asked: string[] = [];
    const wrote: string[] = [];

    const attempt = () =>
      loadConfigReport(
        { BANDAR_HOME: home, BANDAR_PORT: "99999" },
        {
          read: (target) => {
            asked.push(target);

            return "{}";
          },
          write: (target) => {
            wrote.push(target);
          },
        },
      );

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("BANDAR_PORT");
    expect(asked).toEqual([]);
    expect(wrote).toEqual([]);
  });

  test("the auth-secret warning fires once a boot, and only while the secret is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      warnIfAuthSecretUnset({ BANDAR_AUTH_SECRET: "set" });
      expect(warn).not.toHaveBeenCalled();

      warnIfAuthSecretUnset({});
      expect(warn).toHaveBeenCalledTimes(1);

      warnIfAuthSecretUnset({ BANDAR_AUTH_SECRET: "" });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a config load leaves the warning to the caller that starts a session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      loadConfig({ BANDAR_HOME: home }, ioOf(missingFile));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the derived defaults", () => {
  test("the auth URL follows the resolved port", () => {
    expect(reportOf({ BANDAR_PORT: "4000" }).config.authUrl).toBe("http://localhost:4000");
  });

  test("a production run trusts the loopback on the API port", () => {
    expect(reportOf().config.trustedOrigins).toEqual([
      `http://localhost:${DEFAULT_API_PORT}`,
      `http://127.0.0.1:${DEFAULT_API_PORT}`,
    ]);
  });

  test("a development run adds the web dev server origins", () => {
    expect(reportOf({}, "development").config.trustedOrigins).toEqual([
      `http://localhost:${DEFAULT_API_PORT}`,
      `http://127.0.0.1:${DEFAULT_API_PORT}`,
      `http://localhost:${DEV_WEB_PORT}`,
      `http://127.0.0.1:${DEV_WEB_PORT}`,
    ]);
  });

  test("an auth URL leads the derived origins, so a proxy needs one setting", () => {
    expect(
      reportOf({ BANDAR_AUTH_URL: "https://llm.example.com/auth" }).config.trustedOrigins,
    ).toEqual([
      "https://llm.example.com",
      `http://localhost:${DEFAULT_API_PORT}`,
      `http://127.0.0.1:${DEFAULT_API_PORT}`,
    ]);
  });

  test("a wildcard host adds no host origin", () => {
    for (const host of ["0.0.0.0", "::"]) {
      expect(reportOf({ BANDAR_HOST: host }).config.trustedOrigins).toEqual([
        `http://localhost:${DEFAULT_API_PORT}`,
        `http://127.0.0.1:${DEFAULT_API_PORT}`,
      ]);
    }
  });

  test("a loopback host does not repeat a derived origin", () => {
    expect(
      reportOf({ BANDAR_HOST: "127.0.0.1", BANDAR_PORT: "4000" }).config.trustedOrigins,
    ).toEqual(["http://localhost:4000", "http://127.0.0.1:4000"]);
  });

  test("a LAN host joins the derived origins", () => {
    expect(
      reportOf({ BANDAR_HOST: "10.0.0.5", BANDAR_PORT: "8080" }).config.trustedOrigins,
    ).toEqual(["http://localhost:8080", "http://127.0.0.1:8080", "http://10.0.0.5:8080"]);
  });

  test("an IPv6 host is bracketed", () => {
    expect(reportOf({ BANDAR_HOST: "::1" }).config.trustedOrigins).toEqual([
      `http://localhost:${DEFAULT_API_PORT}`,
      `http://127.0.0.1:${DEFAULT_API_PORT}`,
      `http://[::1]:${DEFAULT_API_PORT}`,
    ]);
  });
});

describe("the config report", () => {
  test("the report names the run mode that shaped the defaults", () => {
    for (const [mode] of MODE_HOMES) {
      expect(reportOf({}, mode).mode).toBe(mode);
    }
  });

  test("the rows name the server keys in order", () => {
    expect(
      reportOf()
        .rows.filter((row) => row.key.startsWith("server."))
        .map((row) => row.key),
    ).toEqual([
      "server.host",
      "server.port",
      "server.tailscale",
      "server.authUrl",
      "server.trustedOrigins",
    ]);
  });

  test("a row carries the resolved value beside its source", () => {
    const rows = reportOf(
      {},
      "production",
      JSON.stringify({
        server: { trustedOrigins: ["https://a.example.com", "https://b.example.com"] },
      }),
    ).rows;

    expect(rows.filter((row) => row.key.startsWith("server.")).map((row) => row.value)).toEqual([
      "0.0.0.0",
      String(DEFAULT_API_PORT),
      "false",
      `http://localhost:${String(DEFAULT_API_PORT)}`,
      "https://a.example.com, https://b.example.com",
    ]);
  });

  test("a missing file reports the path, no file, and every default", () => {
    const report = loadConfigReport(
      { BANDAR_HOME: home, BANDAR_AUTH_SECRET: "set" },
      ioOf(missingFile),
      "production",
    );

    expect(report.settingsPath).toBe("/srv/bandar/config.json");
    expect(report.settingsFound).toBe(false);
    expect(sourcesOf(report)).toEqual({
      "server.host": "default",
      "server.port": "default",
      "server.tailscale": "default",
      "server.authUrl": "default",
      "server.trustedOrigins": "default",
    });
  });

  test("a file beats the environment and labels what it supplies", () => {
    const report = reportOf(
      {
        BANDAR_HOST: "10.0.0.5",
        BANDAR_PORT: "5000",
        BANDAR_AUTH_URL: "https://env.example.com",
        BANDAR_TRUSTED_ORIGINS: "https://env.example.com",
      },
      "production",
      JSON.stringify({
        server: {
          host: "127.0.0.1",
          port: 4000,
          authUrl: "https://llm.example.com",
          trustedOrigins: ["https://llm.example.com"],
        },
      }),
    );

    expect(sourcesOf(report)).toEqual({
      "server.host": "config",
      "server.port": "config",
      "server.tailscale": "default",
      "server.authUrl": "config",
      "server.trustedOrigins": "config",
    });
  });

  test("a file labels every value it supplies", () => {
    const report = reportOf(
      {},
      "production",
      JSON.stringify({
        server: {
          host: "127.0.0.1",
          port: 4000,
          authUrl: "https://llm.example.com",
          trustedOrigins: ["https://llm.example.com"],
        },
      }),
    );

    expect(report.settingsFound).toBe(true);
    expect(sourcesOf(report)).toEqual({
      "server.host": "config",
      "server.port": "config",
      "server.tailscale": "default",
      "server.authUrl": "config",
      "server.trustedOrigins": "config",
    });
  });

  test("the environment labels the values it supplies, and a blank one falls through", () => {
    const report = reportOf({
      BANDAR_HOST: "10.0.0.5",
      BANDAR_PORT: "5000",
      BANDAR_AUTH_URL: "https://llm.example.com",
      BANDAR_TRUSTED_ORIGINS: "https://llm.example.com",
    });

    expect(sourcesOf(report)).toEqual({
      "server.host": "environment",
      "server.port": "environment",
      "server.tailscale": "default",
      "server.authUrl": "environment",
      "server.trustedOrigins": "environment",
    });

    const blank = reportOf({
      BANDAR_HOST: "",
      BANDAR_PORT: "",
      BANDAR_AUTH_URL: "",
      BANDAR_TRUSTED_ORIGINS: "",
    });

    expect(sourcesOf(blank)).toEqual({
      "server.host": "default",
      "server.port": "default",
      "server.tailscale": "default",
      "server.authUrl": "default",
      "server.trustedOrigins": "default",
    });
  });

  test("a development run trusts the web dev server", () => {
    expect(reportOf({}, "development").config.trustedOrigins).toEqual([
      `http://localhost:${String(DEFAULT_API_PORT)}`,
      `http://127.0.0.1:${String(DEFAULT_API_PORT)}`,
      `http://localhost:${String(DEV_WEB_PORT)}`,
      `http://127.0.0.1:${String(DEV_WEB_PORT)}`,
    ]);
  });

  test("each value keeps its own label", () => {
    const report = reportOf(
      { BANDAR_AUTH_URL: "https://llm.example.com" },
      "production",
      JSON.stringify({ server: { host: "127.0.0.1", port: 4000 } }),
    );

    expect(sourcesOf(report)).toEqual({
      "server.host": "config",
      "server.port": "config",
      "server.tailscale": "default",
      "server.authUrl": "environment",
      "server.trustedOrigins": "default",
    });
  });
});

describe("the tailnet bind", () => {
  const tailnet: TailnetIdentity = { address: "100.90.57.79", dnsName: "host.tailnet.ts.net" };
  const found: TailnetLookup = () => ({ kind: "found", identity: tailnet });

  const withTailscale = (server: { readonly host?: string; readonly authUrl?: string }): string =>
    JSON.stringify({ server: { tailscale: true, ...server } });

  test("the tailnet address and the MagicDNS auth URL replace the host and loopback", () => {
    const report = reportOf({}, "production", withTailscale({}), found);

    expect(report.config.host).toBe(tailnet.address);
    expect(report.config.authUrl).toBe(`http://${tailnet.dnsName}:${String(DEFAULT_API_PORT)}`);
    expect(sourcesOf(report)).toMatchObject({
      "server.host": "tailscale",
      "server.authUrl": "tailscale",
      "server.tailscale": "config",
    });
    expect(report.config.trustedOrigins).toEqual([
      `http://${tailnet.dnsName}:${String(DEFAULT_API_PORT)}`,
      `http://${tailnet.address}:${String(DEFAULT_API_PORT)}`,
    ]);
  });

  test("the tailnet address wins over a configured host", () => {
    const report = reportOf({}, "production", withTailscale({ host: "127.0.0.1" }), found);

    expect(report.config.host).toBe(tailnet.address);
  });

  test("a development run trusts the dev server by its tailnet names", () => {
    const report = reportOf({}, "development", withTailscale({}), found);

    expect(report.config.trustedOrigins).toEqual([
      `http://${tailnet.dnsName}:${String(DEFAULT_API_PORT)}`,
      `http://${tailnet.address}:${String(DEFAULT_API_PORT)}`,
      `http://${tailnet.dnsName}:${String(DEV_WEB_PORT)}`,
      `http://${tailnet.address}:${String(DEV_WEB_PORT)}`,
    ]);
  });

  test("an explicit auth URL wins, and the MagicDNS name is still trusted", () => {
    const report = reportOf(
      {},
      "production",
      withTailscale({ authUrl: "https://llm.example.com" }),
      found,
    );

    expect(report.config.authUrl).toBe("https://llm.example.com");
    expect(report.config.trustedOrigins).toContain(
      `http://${tailnet.dnsName}:${String(DEFAULT_API_PORT)}`,
    );
  });

  test("a missing tailnet fails the boot with the reason", () => {
    expect(() =>
      reportOf({}, "production", withTailscale({}), () => ({
        kind: "missing",
        reason: "tailscale backend is NeedsLogin",
      })),
    ).toThrow(/server\.tailscale: tailscale backend is NeedsLogin/u);
  });

  test("the flag off never asks for the tailnet", () => {
    expect(() => reportOf()).not.toThrow();
  });
});

describe("the provider endpoints", () => {
  test("every kind takes its default", () => {
    const providers = reportOf().config.providers;

    expect(providers.kilocode).toEqual({
      baseUrl: "https://api.kilo.ai/api/openrouter",
      catalogUrl: "https://api.kilo.ai/api/gateway/models",
      authUrl: "https://api.kilo.ai",
    });
    expect(providers.tokenharbor).toEqual({
      baseUrl: "https://tokenharbor.ai/v1",
      catalogUrl: null,
      authUrl: null,
    });
    expect(providers.yeta).toEqual({
      baseUrl: "https://platform.yeta.ai/v1",
      catalogUrl: null,
      authUrl: null,
    });
    expect(providers.river).toEqual({
      baseUrl: "https://api.river.ai/v1",
      catalogUrl: "https://console.river.ai/api/public/pricing",
      authUrl: null,
    });
    expect(providers.nous).toEqual({
      baseUrl: "https://inference-api.nousresearch.com/v1",
      catalogUrl: null,
      authUrl: "https://portal.nousresearch.com",
    });
    expect(providers.hyper.baseUrl).toBe("https://hyper.charm.land/v1");
    expect(providers.opencode.baseUrl).toBe("https://opencode.ai/inference");
    expect(providers.zro.baseUrl).toBe("https://zro.moonmath.ai/v1");
  });

  test("the file supplies full base URLs, without a mount", () => {
    const config = fromFile(
      JSON.stringify({
        providers: {
          hyper: { baseUrl: "https://hyper.example.test/inference" },
          river: {
            baseUrl: "https://river.example.test/api",
            catalogUrl: "https://river.example.test/pricing",
          },
          nous: { authUrl: "https://portal.example.test/oauth" },
        },
      }),
    );

    expect(config.providers.hyper.baseUrl).toBe("https://hyper.example.test/inference");
    expect(config.providers.river).toEqual({
      baseUrl: "https://river.example.test/api",
      catalogUrl: "https://river.example.test/pricing",
      authUrl: null,
    });
    expect(config.providers.nous.authUrl).toBe("https://portal.example.test/oauth");
  });

  test("the environment origin gains the kind's mount", () => {
    const config = fromFile("{}", {
      BANDAR_HYPER_API: "http://127.0.0.1:9/hyper/",
      BANDAR_OPENCODE_API: "http://127.0.0.1:9/opencode",
      BANDAR_RIVER_PRICING_URL: "http://127.0.0.1:9/river/pricing",
    });

    expect(config.providers.hyper.baseUrl).toBe("http://127.0.0.1:9/hyper/v1");
    expect(config.providers.opencode.baseUrl).toBe("http://127.0.0.1:9/opencode/inference");
    expect(config.providers.river.catalogUrl).toBe("http://127.0.0.1:9/river/pricing");
  });

  test("kilocode derives its login origin from the base URL", () => {
    const withoutMount = fromFile(
      JSON.stringify({ providers: { kilocode: { baseUrl: "http://127.0.0.1:9/gateway" } } }),
    );

    const withMount = fromFile(
      JSON.stringify({
        providers: { kilocode: { baseUrl: "http://127.0.0.1:9/api/openrouter" } },
      }),
    );

    expect(withoutMount.providers.kilocode.authUrl).toBe("http://127.0.0.1:9");
    expect(withMount.providers.kilocode.authUrl).toBe("http://127.0.0.1:9");
  });

  test("the file labels each provider field", () => {
    const report = reportOf(
      { BANDAR_RIVER_API: "http://127.0.0.1:9/river" },
      "production",
      JSON.stringify({
        providers: { kilocode: { catalogUrl: "https://kilo.example.test/models" } },
      }),
    );

    expect(sourcesOf(report, "providers.")).toEqual({
      "providers.kilocode.baseUrl": "default",
      "providers.kilocode.catalogUrl": "config",
      "providers.tokenharbor.baseUrl": "default",
      "providers.yeta.baseUrl": "default",
      "providers.river.baseUrl": "environment",
      "providers.river.catalogUrl": "default",
      "providers.nous.baseUrl": "default",
      "providers.nous.authUrl": "default",
      "providers.hyper.baseUrl": "default",
      "providers.opencode.baseUrl": "default",
      "providers.zro.baseUrl": "default",
    });
  });

  test("a provider URL in the file must be http or https", () => {
    const attempt = () => fromFile('{"providers":{"hyper":{"baseUrl":"javascript:alert(1)"}}}');

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("providers.hyper.baseUrl");
    expect(attempt).toThrow("must be an http or https URL");
  });

  test("an unknown kind or an unknown field fails the boot", () => {
    for (const json of [
      '{"providers":{"nope":{}}}',
      '{"providers":{"kilocode":{"authUrl":"https://x.test"}}}',
      '{"providers":{"hyper":{"catalogUrl":"https://x.test"}}}',
    ]) {
      const attempt = () => fromFile(json);

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow("invalid configuration");
    }
  });
});

describe("the update feed", () => {
  test("the defaults name the public repository and no API feed", () => {
    expect(reportOf().config.update).toEqual({
      webUrl: "https://github.com/falentio/bandar",
      apiUrl: null,
    });
  });

  test("the file supplies both URLs", () => {
    const config = fromFile(
      JSON.stringify({
        update: {
          webUrl: "https://web.example.test/bandar",
          apiUrl: "https://api.example.test/releases/latest",
        },
      }),
    );

    expect(config.update).toEqual({
      webUrl: "https://web.example.test/bandar",
      apiUrl: "https://api.example.test/releases/latest",
    });
  });

  test("the environment stands in when the file is silent", () => {
    const config = fromFile("{}", {
      BANDAR_RELEASE_WEB_URL: "https://web.example.test/bandar",
      BANDAR_RELEASE_API_URL: "https://api.example.test/releases/latest",
    });

    expect(config.update).toEqual({
      webUrl: "https://web.example.test/bandar",
      apiUrl: "https://api.example.test/releases/latest",
    });
  });

  test("the file outranks the environment", () => {
    const config = fromFile(
      JSON.stringify({ update: { webUrl: "https://file.example.test/bandar" } }),
      {
        BANDAR_RELEASE_WEB_URL: "https://env.example.test/bandar",
        BANDAR_RELEASE_API_URL: "https://api.example.test/releases/latest",
      },
    );

    expect(config.update).toEqual({
      webUrl: "https://file.example.test/bandar",
      apiUrl: "https://api.example.test/releases/latest",
    });
  });

  test("the rows name the update keys, printing none for an absent feed", () => {
    const rows = reportOf(
      {},
      "production",
      JSON.stringify({ update: { webUrl: "https://web.example.test/bandar" } }),
    ).rows.filter((row) => row.key.startsWith("update."));

    expect(rows).toEqual([
      {
        key: "update.webUrl",
        value: "https://web.example.test/bandar",
        source: "config",
      },
      { key: "update.apiUrl", value: "none", source: "default" },
    ]);
  });

  test("an update URL that is not http or https fails the boot", () => {
    const attempt = () => fromFile('{"update":{"webUrl":"javascript:alert(1)"}}');

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("update.webUrl");
  });

  test("an unknown update key fails the boot", () => {
    const attempt = () => fromFile('{"update":{"pageUrl":"https://x.test"}}');

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("update.pageUrl");
  });
});
