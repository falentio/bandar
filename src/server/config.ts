import { z } from "zod";
import { DEFAULT_API_PORT } from "../shared/topology";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
};

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid environment:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const ConfigSchema = z.object({
  BANDAR_HOST: z.string().trim().min(1).default("0.0.0.0"),
  BANDAR_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_API_PORT),
  BANDAR_DB: z.string().trim().min(1).default("./bandar.db"),
});

export function parseConfig(env: Record<string, string | undefined>): Config {
  const given = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );

  const parsed = ConfigSchema.safeParse(given);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  return {
    host: parsed.data.BANDAR_HOST,
    port: parsed.data.BANDAR_PORT,
    databasePath: parsed.data.BANDAR_DB,
  };
}
