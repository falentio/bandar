import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as v from "valibot";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from "../shared/topology";

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

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid environment:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
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

const DEFAULT_HOME_DIR = join(homedir(), ".bandar");

const DATABASE_FILE = "bandar.db";

const DUCKDB_FILE = "bandar.duckdb";

// v.optional validates its default against the input type, so the port default is the string form.
const ConfigSchema = v.object({
  BANDAR_HOST: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1)), "0.0.0.0"),
  BANDAR_PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(65535),
    ),
    String(DEFAULT_API_PORT),
  ),
  BANDAR_HOME: v.pipe(v.string(), v.trim(), v.check(isAbsolute, "must be an absolute path")),
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

export function parseConfig(env: Record<string, string | undefined>): Config {
  // A blank value means "unset" for every variable but the two directories: install.sh writes its
  // manifest under the config directory it was given, and a blank home would move the databases to
  // the working directory, so a blank one has to fail, not fall back.
  const given = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        value !== undefined &&
        (value !== "" || name === "BANDAR_CONFIG_DIR" || name === "BANDAR_HOME"),
    ),
  );

  // Filled in here rather than as a schema default: v.optional checks its default against the
  // input type, so a default that went through trim and check would fail on the leading space.
  given.BANDAR_HOME ??= DEFAULT_HOME_DIR;

  const parsed = v.safeParse(ConfigSchema, given);

  if (!parsed.success) {
    const issues = parsed.issues.map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";

      return `${path || "environment"}: ${issue.message}`;
    });

    throw new ConfigError(issues);
  }

  const values = parsed.output;

  if (values.BANDAR_AUTH_SECRET === undefined)
    console.warn(
      "bandar: BANDAR_AUTH_SECRET is unset; a random secret was generated for this boot, " +
        "so every session ends when the process stops. Set it to keep sessions across restarts.",
    );

  return {
    host: values.BANDAR_HOST,
    port: values.BANDAR_PORT,
    databasePath: join(values.BANDAR_HOME, DATABASE_FILE),
    duckdbPath: join(values.BANDAR_HOME, DUCKDB_FILE),
    configDir: values.BANDAR_CONFIG_DIR,
    authUrl: values.BANDAR_AUTH_URL ?? `http://localhost:${values.BANDAR_PORT}`,
    authSecret: values.BANDAR_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    trustedOrigins: values.BANDAR_TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  };
}
