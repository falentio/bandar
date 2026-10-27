import { randomBytes } from "node:crypto";
import * as v from "valibot";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from "../shared/topology";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
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
  BANDAR_DB: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1)), "./bandar.db"),
  BANDAR_AUTH_URL: v.optional(v.pipe(v.string(), v.trim(), v.url())),
  BANDAR_AUTH_SECRET: v.optional(v.pipe(v.string(), v.minLength(1))),
  BANDAR_TRUSTED_ORIGINS: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1)),
    DEFAULT_TRUSTED_ORIGINS,
  ),
});

export function parseConfig(env: Record<string, string | undefined>): Config {
  const given = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
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

  if (values.BANDAR_AUTH_SECRET === undefined)
    console.warn(
      "bandar: BANDAR_AUTH_SECRET is unset; a random secret was generated for this boot, " +
        "so every session ends when the process stops. Set it to keep sessions across restarts.",
    );

  return {
    host: values.BANDAR_HOST,
    port: values.BANDAR_PORT,
    databasePath: values.BANDAR_DB,
    authUrl: values.BANDAR_AUTH_URL ?? `http://localhost:${values.BANDAR_PORT}`,
    authSecret: values.BANDAR_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    trustedOrigins: values.BANDAR_TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  };
}
