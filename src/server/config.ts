import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as v from "valibot";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, MAX_PORT, MIN_PORT } from "../shared/topology";
import { readSettings, type Settings } from "./settings";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly duckdbPath: string;
  readonly configDir: string;
  readonly authUrl: string;
  readonly authSecret: string;
  readonly trustedOrigins: readonly string[];
};

export type RunMode = "development" | "production";

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], summary = "invalid environment") {
    super(`${summary}:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const DEFAULT_TRUSTED_ORIGINS = [
  `http://localhost:${DEFAULT_WEB_PORT}`,
  `http://127.0.0.1:${DEFAULT_WEB_PORT}`,
].join(",");

const ProviderUrlSchema = v.pipe(v.string(), v.trim(), v.url());

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "bandar");

const HOME_DIRS = {
  development: join(homedir(), ".bandar_dev"),
  production: join(homedir(), ".bandar"),
} satisfies Record<RunMode, string>;

// Bun bakes NODE_ENV into a compiled binary at build time, so NODE_ENV cannot separate a dev run
// from an installed one.
export function detectRunMode(): RunMode {
  return Bun.isStandaloneExecutable ? "production" : "development";
}

const DEFAULT_HOST = "0.0.0.0";

const DATABASE_FILE = "bandar.db";

const DUCKDB_FILE = "bandar.duckdb";

const UNSET_SECRET_WARNING =
  "bandar: BANDAR_AUTH_SECRET is unset; a random secret was generated for this boot, " +
  "so every session ends when the process stops. Set it to keep sessions across restarts.";

// The host and the port carry no default here: a value missing from the environment comes from the
// settings file, and only then from the built-in default in buildConfig.
const ConfigSchema = v.object({
  BANDAR_HOST: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  BANDAR_PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(MIN_PORT),
      v.maxValue(MAX_PORT),
    ),
  ),
  BANDAR_CONFIG_DIR: v.optional(
    v.pipe(v.string(), v.trim(), v.check(isAbsolute, "must be an absolute path")),
    DEFAULT_CONFIG_DIR,
  ),
  BANDAR_AUTH_URL: v.optional(v.pipe(v.string(), v.trim(), v.url())),
  BANDAR_AUTH_SECRET: v.optional(v.pipe(v.string(), v.minLength(1))),
  BANDAR_TRUSTED_ORIGINS: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1)),
    DEFAULT_TRUSTED_ORIGINS,
  ),
  // Providers read these at request time, so the shape is checked here instead.
  BANDAR_KILOCODE_API: v.optional(ProviderUrlSchema),
  BANDAR_KILOCODE_MODELS_URL: v.optional(ProviderUrlSchema),
  BANDAR_TOKENHARBOR_API: v.optional(ProviderUrlSchema),
  BANDAR_YETA_API: v.optional(ProviderUrlSchema),
  BANDAR_RIVER_API: v.optional(ProviderUrlSchema),
  BANDAR_RIVER_PRICING_URL: v.optional(ProviderUrlSchema),
  BANDAR_NOUS_API: v.optional(ProviderUrlSchema),
  BANDAR_NOUS_PORTAL: v.optional(ProviderUrlSchema),
  BANDAR_HYPER_API: v.optional(ProviderUrlSchema),
  BANDAR_OPENCODE_API: v.optional(ProviderUrlSchema),
});

/**
 * The home directory decides where the settings file lives, and both the file read and the config
 * build need it, so it is resolved once, before either runs.
 */
function resolveHome(env: Record<string, string | undefined>, mode: RunMode): string {
  const home = (env.BANDAR_HOME ?? HOME_DIRS[mode]).trim();

  if (!isAbsolute(home)) throw new ConfigError(["BANDAR_HOME: must be an absolute path"]);

  return home;
}

/**
 * Fills the config from the environment first, then the settings file, then the built-in default.
 * It stays silent: backup, update, and install-service parse the environment without starting a
 * session, so the warning about a generated secret belongs to loadConfig.
 */
function buildConfig(
  env: Record<string, string | undefined>,
  home: string,
  settings: Settings,
): Config {
  // A blank value means "unset" for every variable but BANDAR_CONFIG_DIR: install.sh writes its
  // manifest under the config directory it was given, so a blank one has to fail, not fall back.
  const given = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => value !== undefined && (value !== "" || name === "BANDAR_CONFIG_DIR"),
    ),
  );

  const parsed = v.safeParse(ConfigSchema, given);

  if (!parsed.success) {
    const issues = parsed.issues.map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";

      return `${path || "environment"}: ${issue.message}`;
    });

    throw new ConfigError(issues);
  }

  const values = parsed.output;
  const port = values.BANDAR_PORT ?? settings.server?.port ?? DEFAULT_API_PORT;

  return {
    host: values.BANDAR_HOST ?? settings.server?.host ?? DEFAULT_HOST,
    port,
    databasePath: join(home, DATABASE_FILE),
    duckdbPath: join(home, DUCKDB_FILE),
    configDir: values.BANDAR_CONFIG_DIR,
    authUrl: values.BANDAR_AUTH_URL ?? `http://localhost:${port}`,
    authSecret: values.BANDAR_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    trustedOrigins: values.BANDAR_TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  };
}

export function parseConfig(
  env: Record<string, string | undefined>,
  mode: RunMode = detectRunMode(),
): Config {
  return buildConfig(env, resolveHome(env, mode), {});
}

/**
 * Reads the settings file and the environment into one config. A file that cannot be read or
 * parsed fails the boot, because a typo there would otherwise start the server on a default.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
  mode: RunMode = detectRunMode(),
): Config {
  const home = resolveHome(env, mode);
  const report = readSettings(home, read);

  if (report.kind === "invalid")
    throw new ConfigError([`${report.path}: ${report.reason}`], "invalid configuration");

  const config = buildConfig(env, home, report.kind === "ok" ? report.settings : {});

  if ((env.BANDAR_AUTH_SECRET ?? "") === "") console.warn(UNSET_SECRET_WARNING);

  return config;
}
