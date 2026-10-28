import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as v from "valibot";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, MAX_PORT, MIN_PORT } from "../shared/topology";
import { HttpUrlSchema, OriginSchema, readSettings, type Settings } from "./settings";

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

export type ConfigSource = "environment" | "config" | "default";

export type ConfigSources = {
  readonly host: ConfigSource;
  readonly port: ConfigSource;
  readonly authUrl: ConfigSource;
  readonly trustedOrigins: ConfigSource;
};

type BuiltConfig = {
  readonly config: Config;
  readonly sources: ConfigSources;
};

export type ConfigReport = {
  readonly config: Config;
  readonly mode: RunMode;
  readonly settingsPath: string;
  readonly settingsFound: boolean;
  readonly sources: ConfigSources;
};

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], summary = "invalid environment") {
    super(`${summary}:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

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

const TRUSTED_ORIGINS_ENV = "BANDAR_TRUSTED_ORIGINS";

const DATABASE_FILE = "bandar.db";

const DUCKDB_FILE = "bandar.duckdb";

const UNSET_SECRET_WARNING =
  "bandar: BANDAR_AUTH_SECRET is unset; a random secret was generated for this boot, " +
  "so every session ends when the process stops. Set it to keep sessions across restarts.";

// Host, port, auth URL, and trusted origins carry no default here: a value missing from the
// environment comes from the settings file, and only then from the built-in default in buildConfig.
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
  BANDAR_AUTH_URL: v.optional(HttpUrlSchema),
  BANDAR_AUTH_SECRET: v.optional(v.pipe(v.string(), v.minLength(1))),
  BANDAR_TRUSTED_ORIGINS: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
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
 * Fills the config from the environment first, then the settings file, then the built-in default,
 * and reports which of the three each server value came from. It stays silent: backup, update, and
 * install-service parse the environment without starting a session, so the warning about a
 * generated secret belongs to loadConfigReport.
 */
function buildConfig(
  env: Record<string, string | undefined>,
  home: string,
  mode: RunMode,
  settings: Settings,
): BuiltConfig {
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
  const server = settings.server;

  const environmentOrigins =
    values.BANDAR_TRUSTED_ORIGINS === undefined
      ? undefined
      : parseOrigins(values.BANDAR_TRUSTED_ORIGINS);

  const host = resolve(values.BANDAR_HOST, server?.host, DEFAULT_HOST);
  const port = resolve(values.BANDAR_PORT, server?.port, DEFAULT_API_PORT);

  const authUrl = resolve(
    values.BANDAR_AUTH_URL,
    server?.authUrl,
    `http://localhost:${port.value}`,
  );

  const trustedOrigins = resolve(
    environmentOrigins,
    server?.trustedOrigins,
    defaultTrustedOrigins(authUrl.value, host.value, port.value, mode),
  );

  return {
    config: {
      host: host.value,
      port: port.value,
      databasePath: join(home, DATABASE_FILE),
      duckdbPath: join(home, DUCKDB_FILE),
      configDir: values.BANDAR_CONFIG_DIR,
      authUrl: authUrl.value,
      authSecret: values.BANDAR_AUTH_SECRET ?? randomBytes(32).toString("hex"),
      trustedOrigins: trustedOrigins.value,
    },
    sources: {
      host: host.source,
      port: port.source,
      authUrl: authUrl.source,
      trustedOrigins: trustedOrigins.source,
    },
  };
}

type Resolved<T> = {
  readonly value: T;
  readonly source: ConfigSource;
};

/**
 * The one place the three tiers are ordered: the environment, then the settings file, then the
 * built-in default. Each tier returns its own label beside the value it supplied.
 */
function resolve<T>(environment: T | undefined, file: T | undefined, fallback: T): Resolved<T> {
  if (environment !== undefined) return { value: environment, source: "environment" };

  if (file !== undefined) return { value: file, source: "config" };

  return { value: fallback, source: "default" };
}

/**
 * Splits the environment list into the form the settings file stores: one normalized origin per
 * entry. An entry that is not an origin fails the boot, because a trailing slash would otherwise
 * reach the browser check and lock every origin out.
 */
function parseOrigins(value: string): readonly string[] {
  const origins: string[] = [];
  const issues: string[] = [];

  for (const part of value.split(",")) {
    const entry = part.trim();

    if (entry === "") continue;

    const parsed = v.safeParse(OriginSchema, entry);

    if (parsed.success) origins.push(parsed.output);
    else
      issues.push(
        `${TRUSTED_ORIGINS_ENV}: ${entry}: ${parsed.issues[0]?.message ?? "invalid origin"}`,
      );
  }

  if (issues.length > 0) throw new ConfigError(issues);

  if (origins.length === 0)
    throw new ConfigError([`${TRUSTED_ORIGINS_ENV}: needs at least one origin`]);

  return origins;
}

/**
 * The origins a browser can reach a fresh install from: the auth URL's own origin first, since that
 * is the public face, then the loopback on the listening port. The dev web server runs on its own port,
 * so only a development run can sign in through it.
 */
function defaultTrustedOrigins(
  authUrl: string,
  host: string,
  port: number,
  mode: RunMode,
): readonly string[] {
  const origins = [new URL(authUrl).origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const anywhere = host === "0.0.0.0" || host === "::";

  if (!anywhere) origins.push(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);

  if (mode === "development")
    origins.push(`http://localhost:${DEFAULT_WEB_PORT}`, `http://127.0.0.1:${DEFAULT_WEB_PORT}`);

  return [...new Set(origins)];
}

export function parseConfig(
  env: Record<string, string | undefined>,
  mode: RunMode = detectRunMode(),
): Config {
  return buildConfig(env, resolveHome(env, mode), mode, {}).config;
}

/**
 * Reads the settings file and the environment into one config, plus the path it read and where
 * each server value came from. A file that cannot be read or parsed fails the boot, because a typo
 * there would otherwise start the server on a default.
 */
export function loadConfigReport(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
  mode: RunMode = detectRunMode(),
): ConfigReport {
  const home = resolveHome(env, mode);
  const report = readSettings(home, read);

  if (report.kind === "invalid")
    throw new ConfigError([`${report.path}: ${report.reason}`], "invalid configuration");

  const { config, sources } = buildConfig(
    env,
    home,
    mode,
    report.kind === "ok" ? report.settings : {},
  );

  if ((env.BANDAR_AUTH_SECRET ?? "") === "") console.warn(UNSET_SECRET_WARNING);

  return { config, mode, settingsPath: report.path, settingsFound: report.kind === "ok", sources };
}

export function loadConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
  mode: RunMode = detectRunMode(),
): Config {
  return loadConfigReport(env, read, mode).config;
}
