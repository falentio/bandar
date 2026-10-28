import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_API_PORT } from "../shared/topology";
import { ConfigError, detectRunMode, loadConfig, parseConfig } from "./config";

const MODE_HOMES = [
  ["development", ".bandar_dev"],
  ["production", ".bandar"],
] as const;

describe("config", () => {
  test("a provider origin that is not a URL fails at boot", () => {
    for (const name of [
      "BANDAR_KILOCODE_API",
      "BANDAR_KILOCODE_MODELS_URL",
      "BANDAR_TOKENHARBOR_API",
      "BANDAR_YETA_API",
      "BANDAR_RIVER_API",
      "BANDAR_RIVER_PRICING_URL",
      "BANDAR_NOUS_API",
      "BANDAR_NOUS_PORTAL",
      "BANDAR_HYPER_API",
      "BANDAR_OPENCODE_API",
    ]) {
      const attempt = () => parseConfig({ [name]: "hyper.local" });

      expect(attempt).toThrow(ConfigError);
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
  const home = "/srv/bandar";

  const file = JSON.stringify({ server: { host: "127.0.0.1", port: 4000 } });

  const fromFile = (json: string, env: Record<string, string | undefined> = {}) =>
    loadConfig({ BANDAR_HOME: home, ...env }, () => json, "production");

  const missingFile = (): string => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  };

  test("the file supplies the host and the port", () => {
    const config = fromFile(file);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.authUrl).toBe("http://localhost:4000");
  });

  test("the environment overrides the file", () => {
    const config = fromFile(file, { BANDAR_HOST: "10.0.0.5", BANDAR_PORT: "5000" });

    expect(config.host).toBe("10.0.0.5");
    expect(config.port).toBe(5000);
  });

  test("a blank environment value falls through to the file", () => {
    const config = fromFile(file, { BANDAR_HOST: "", BANDAR_PORT: "" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
  });

  test("loadConfig reads config.json under BANDAR_HOME", () => {
    const asked: string[] = [];

    loadConfig({ BANDAR_HOME: home }, (path) => {
      asked.push(path);

      return "{}";
    });

    expect(asked).toEqual(["/srv/bandar/config.json"]);
  });

  test("a missing file leaves the defaults", () => {
    const config = loadConfig({ BANDAR_HOME: home }, missingFile);

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(DEFAULT_API_PORT);
  });

  test("an invalid file fails the boot, naming the file and the field", () => {
    const attempt = () => loadConfig({ BANDAR_HOME: home }, () => '{"server":{"port":70000}}');

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow("invalid configuration");
    expect(attempt).toThrow("/srv/bandar/config.json: server.port");
  });

  test("a blank BANDAR_HOME fails before the file is read", () => {
    const attempt = () => loadConfig({ BANDAR_HOME: "" }, missingFile);

    expect(attempt).toThrow("BANDAR_HOME: must be an absolute path");
  });

  test("the auth-secret warning fires once a boot, and only while the secret is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      loadConfig({ BANDAR_HOME: home, BANDAR_AUTH_SECRET: "set" }, missingFile);
      expect(warn).not.toHaveBeenCalled();

      loadConfig({ BANDAR_HOME: home }, missingFile);
      expect(warn).toHaveBeenCalledTimes(1);

      loadConfig({ BANDAR_HOME: home, BANDAR_AUTH_SECRET: "" }, missingFile);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
