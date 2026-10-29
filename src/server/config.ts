import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as v from "valibot";
import { BUILT_IN_PROVIDER_KINDS, type BuiltInProviderKind } from "../shared/providers";
import {
  authUrlForPort,
  DEFAULT_API_PORT,
  DEFAULT_HOST,
  DEV_WEB_PORT,
  loopbackOrigin,
  MAX_PORT,
  MIN_PORT,
} from "../shared/topology";
import {
  endpointSpecsFor,
  providerEndpoint,
  withMount,
  type EndpointField,
  type ProviderEndpoint,
  type ProviderEndpoints,
} from "./providers/endpoints";
import {
  HttpUrlSchema,
  OriginSchema,
  loadSettings,
  type Settings,
  type SettingsIo,
} from "./settings";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly duckdbPath: string;
  readonly configDir: string;
  readonly authUrl: string;
  readonly authSecret: string;
  readonly trustedOrigins: readonly string[];
  readonly providers: ProviderEndpoints;
  readonly update: { readonly webUrl: string; readonly apiUrl: string | null };
};

export type RunMode = "development" | "production";

export type ConfigSource = "environment" | "config" | "default";

export type ConfigRow = {
  readonly key: string;
  readonly value: string;
  readonly source: ConfigSource;
};

type ConfigSources = {
  readonly host: ConfigSource;
  readonly port: ConfigSource;
  readonly authUrl: ConfigSource;
  readonly trustedOrigins: ConfigSource;
  readonly updateWebUrl: ConfigSource;
  readonly updateApiUrl: ConfigSource;
};

type BuiltConfig = {
  readonly config: Config;
  readonly sources: ConfigSources;
  readonly providerRows: readonly ConfigRow[];
};

export type ConfigReport = {
  readonly config: Config;
  readonly mode: RunMode;
  readonly settingsPath: string;
  readonly settingsFound: boolean;
  readonly rows: readonly ConfigRow[];
};

export class ConfigError extends Error {
  readonly issues: readonly string[];
  readonly summary: string;

  constructor(issues: readonly string[], summary = "invalid environment") {
    super(`${summary}:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
    this.summary = summary;
  }
}

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

const TRUSTED_ORIGINS_ENV = "BANDAR_TRUSTED_ORIGINS";

const DATABASE_FILE = "bandar.db";

const DUCKDB_FILE = "bandar.duckdb";

const PUBLIC_WEB_URL = "https://github.com/falentio/bandar";

const UNSET_SECRET_WARNING =
  "bandar: BANDAR_AUTH_SECRET is unset; a random secret was generated for this boot, " +
  "so every session ends when the process stops. Set it to keep sessions across restarts.";

// Host, port, auth URL, and trusted origins carry no default here: a value missing from the
// settings file falls back to the environment, and only then to the built-in default in buildConfig.
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
  BANDAR_RELEASE_WEB_URL: v.optional(HttpUrlSchema),
  BANDAR_RELEASE_API_URL: v.optional(HttpUrlSchema),
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

type Environment = v.InferOutput<typeof ConfigSchema>;

type EndpointEnvValue = {
  readonly kind: BuiltInProviderKind;
  readonly field: EndpointField;
  readonly value: string;
};

type ParsedEnvironment = {
  readonly environment: Environment;
  readonly endpoints: readonly EndpointEnvValue[];
};

const ENDPOINT_FIELDS: readonly EndpointField[] = ["baseUrl", "catalogUrl", "authUrl"];

/**
 * The environment, parsed once. Every rejected value is collected before the throw, so one line
 * names all of them, and the throw lands before the settings read writes into the data directory.
 */
function parseEnvironment(env: Record<string, string | undefined>): ParsedEnvironment {
  // A blank value means "unset" for every variable but BANDAR_CONFIG_DIR: install.sh writes its
  // manifest under the config directory it was given, so a blank one has to fail, not fall back.
  const given = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => value !== undefined && (value !== "" || name === "BANDAR_CONFIG_DIR"),
    ),
  );

  const parsed = v.safeParse(ConfigSchema, given);
  const endpointIssues: string[] = [];
  const endpoints = endpointValues(env, endpointIssues);

  if (!parsed.success || endpointIssues.length > 0) {
    const environmentIssues = parsed.success
      ? []
      : parsed.issues.map((issue) => {
          const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";

          return `${path || "environment"}: ${issue.message}`;
        });

    throw new ConfigError([...environmentIssues, ...endpointIssues]);
  }

  return { environment: parsed.output, endpoints };
}

/**
 * The provider variables are origins rather than full base URLs, so each one is validated before a
 * mount completes it. A rejected value names the settings key it would fill, because the file holds
 * the same value under that key.
 */
function endpointValues(
  env: Record<string, string | undefined>,
  issues: string[],
): readonly EndpointEnvValue[] {
  const values: EndpointEnvValue[] = [];

  for (const kind of BUILT_IN_PROVIDER_KINDS) {
    const specs = endpointSpecsFor(kind);

    for (const field of ENDPOINT_FIELDS) {
      const spec = specs[field];

      if (spec === undefined) continue;

      const raw = env[spec.env]?.trim();

      if (raw === undefined || raw === "") continue;

      const parsed = v.safeParse(HttpUrlSchema, raw);

      if (parsed.success) values.push({ kind, field, value: parsed.output });
      else
        issues.push(
          `providers.${kind}.${field}: ${spec.env}: ${parsed.issues[0]?.message ?? "invalid URL"}`,
        );
    }
  }

  return values;
}

type EndpointSettings = {
  readonly baseUrl?: string;
  readonly catalogUrl?: string;
  readonly authUrl?: string;
};

function endpointOf(
  kind: BuiltInProviderKind,
  file: EndpointSettings | undefined,
  environment: readonly EndpointEnvValue[],
  rows: ConfigRow[],
): ProviderEndpoint {
  const specs = endpointSpecsFor(kind);

  const environmentValue = (field: EndpointField): string | undefined =>
    environment.find((entry) => entry.kind === kind && entry.field === field)?.value;

  const baseOrigin = environmentValue("baseUrl");

  const base = resolve(
    file?.baseUrl,
    baseOrigin === undefined ? undefined : withMount(kind, baseOrigin),
    specs.baseUrl.default,
  );

  rows.push({ key: `providers.${kind}.baseUrl`, value: base.value, source: base.source });

  const catalog =
    specs.catalogUrl === undefined
      ? null
      : resolve(file?.catalogUrl, environmentValue("catalogUrl"), specs.catalogUrl.default);

  const auth =
    specs.authUrl === undefined
      ? null
      : resolve(file?.authUrl, environmentValue("authUrl"), specs.authUrl.default);

  if (catalog !== null)
    rows.push({
      key: `providers.${kind}.catalogUrl`,
      value: catalog.value,
      source: catalog.source,
    });

  if (auth !== null)
    rows.push({ key: `providers.${kind}.authUrl`, value: auth.value, source: auth.source });

  return providerEndpoint(kind, base.value, catalog?.value ?? null, auth?.value ?? null);
}

type ProviderSites = {
  readonly endpoints: ProviderEndpoints;
  readonly rows: readonly ConfigRow[];
};

function resolveProviders(
  settings: Settings,
  environment: readonly EndpointEnvValue[],
): ProviderSites {
  const rows: ConfigRow[] = [];

  const endpoint = (kind: BuiltInProviderKind): ProviderEndpoint =>
    endpointOf(kind, settings.providers?.[kind], environment, rows);

  return {
    endpoints: {
      kilocode: endpoint("kilocode"),
      tokenharbor: endpoint("tokenharbor"),
      yeta: endpoint("yeta"),
      river: endpoint("river"),
      nous: endpoint("nous"),
      hyper: endpoint("hyper"),
      opencode: endpoint("opencode"),
      zro: endpoint("zro"),
    },
    rows,
  };
}

/**
 * Fills the config from the settings file first, then the environment, then the built-in default,
 * and reports which of the three each server value came from. It stays silent: backup, update, and
 * install-service parse the environment without starting a session, so the warning about a
 * generated secret belongs to the callers that start one.
 */
function buildConfig(
  environment: Environment,
  home: string,
  mode: RunMode,
  settings: Settings,
  endpointEnvironment: readonly EndpointEnvValue[],
): BuiltConfig {
  const server = settings.server;
  const providers = resolveProviders(settings, endpointEnvironment);

  const environmentOrigins =
    environment.BANDAR_TRUSTED_ORIGINS === undefined
      ? undefined
      : parseOrigins(environment.BANDAR_TRUSTED_ORIGINS);

  const host = resolve(server?.host, environment.BANDAR_HOST, DEFAULT_HOST);
  const port = resolve(server?.port, environment.BANDAR_PORT, DEFAULT_API_PORT);
  const authUrl = resolve(server?.authUrl, environment.BANDAR_AUTH_URL, authUrlForPort(port.value));

  const trustedOrigins = resolve(
    server?.trustedOrigins,
    environmentOrigins,
    defaultTrustedOrigins(authUrl.value, host.value, port.value, mode),
  );

  const update = settings.update;
  const updateWebUrl = resolve(update?.webUrl, environment.BANDAR_RELEASE_WEB_URL, PUBLIC_WEB_URL);
  const updateApiUrl = resolve(update?.apiUrl, environment.BANDAR_RELEASE_API_URL, null);

  return {
    config: {
      host: host.value,
      port: port.value,
      databasePath: join(home, DATABASE_FILE),
      duckdbPath: join(home, DUCKDB_FILE),
      configDir: environment.BANDAR_CONFIG_DIR,
      authUrl: authUrl.value,
      authSecret: environment.BANDAR_AUTH_SECRET ?? randomBytes(32).toString("hex"),
      trustedOrigins: trustedOrigins.value,
      providers: providers.endpoints,
      update: { webUrl: updateWebUrl.value, apiUrl: updateApiUrl.value },
    },
    sources: {
      host: host.source,
      port: port.source,
      authUrl: authUrl.source,
      trustedOrigins: trustedOrigins.source,
      updateWebUrl: updateWebUrl.source,
      updateApiUrl: updateApiUrl.source,
    },
    providerRows: providers.rows,
  };
}

type Resolved<T> = {
  readonly value: T;
  readonly source: ConfigSource;
};

/**
 * The one place the three tiers are ordered: the settings file, then the environment, then the
 * built-in default. Each tier returns its own label beside the value it supplied.
 */
function resolve<T>(file: T | undefined, environment: T | undefined, fallback: T): Resolved<T> {
  if (file !== undefined) return { value: file, source: "config" };

  if (environment !== undefined) return { value: environment, source: "environment" };

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
 * is the public face, then the loopback on the listening port. The dev web server always listens on
 * DEV_WEB_PORT, so only a development run can sign in through it.
 */
function defaultTrustedOrigins(
  authUrl: string,
  host: string,
  port: number,
  mode: RunMode,
): readonly string[] {
  const origins = [new URL(authUrl).origin, authUrlForPort(port), loopbackOrigin(port)];
  const anywhere = host === "0.0.0.0" || host === "::";

  if (!anywhere) origins.push(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);

  if (mode === "development")
    origins.push(`http://localhost:${DEV_WEB_PORT}`, `http://127.0.0.1:${DEV_WEB_PORT}`);

  return [...new Set(origins)];
}

function serverRows(config: Config, sources: ConfigSources): readonly ConfigRow[] {
  return [
    { key: "server.host", value: config.host, source: sources.host },
    { key: "server.port", value: String(config.port), source: sources.port },
    { key: "server.authUrl", value: config.authUrl, source: sources.authUrl },
    {
      key: "server.trustedOrigins",
      value: config.trustedOrigins.join(", "),
      source: sources.trustedOrigins,
    },
  ];
}

function updateRows(config: Config, sources: ConfigSources): readonly ConfigRow[] {
  return [
    { key: "update.webUrl", value: config.update.webUrl, source: sources.updateWebUrl },
    {
      key: "update.apiUrl",
      value: config.update.apiUrl ?? "none",
      source: sources.updateApiUrl,
    },
  ];
}

/**
 * A secret with no default and no settings key: a random one keeps this boot alive, so the
 * operator is told once per boot that sessions will not survive it.
 */
export function warnIfAuthSecretUnset(env: Record<string, string | undefined>): void {
  if ((env.BANDAR_AUTH_SECRET ?? "") === "") console.warn(UNSET_SECRET_WARNING);
}

export function parseConfig(
  env: Record<string, string | undefined>,
  mode: RunMode = detectRunMode(),
): Config {
  const home = resolveHome(env, mode);

  const { environment, endpoints } = parseEnvironment(env);

  return buildConfig(environment, home, mode, {}, endpoints).config;
}

/**
 * Reads the settings file and the environment into one config, plus the path it read and where
 * each server value came from. The read writes: config.schema.json lands beside the settings, and a
 * file without a $schema key is pointed at it. A file that cannot be read or parsed fails the boot,
 * because a typo there would otherwise start the server on a default.
 */
export function loadConfigReport(
  env: Record<string, string | undefined>,
  io: SettingsIo,
  mode: RunMode = detectRunMode(),
): ConfigReport {
  const home = resolveHome(env, mode);
  const { environment, endpoints } = parseEnvironment(env);
  const report = loadSettings(home, io);

  if (report.kind === "invalid")
    throw new ConfigError([`${report.path}: ${report.reason}`], "invalid configuration");

  const { config, sources, providerRows } = buildConfig(
    environment,
    home,
    mode,
    report.kind === "ok" ? report.settings : {},
    endpoints,
  );

  return {
    config,
    mode,
    settingsPath: report.path,
    settingsFound: report.kind === "ok",
    rows: [...serverRows(config, sources), ...providerRows, ...updateRows(config, sources)],
  };
}

export function loadConfig(
  env: Record<string, string | undefined>,
  io: SettingsIo,
  mode: RunMode = detectRunMode(),
): Config {
  return loadConfigReport(env, io, mode).config;
}
