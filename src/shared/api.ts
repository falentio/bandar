import * as v from "valibot";

export const API_PREFIX = "/api";
export const GATEWAY_PREFIX = "/v1";

export const apiPaths = {
  health: `${API_PREFIX}/health`,
  backup: `${API_PREFIX}/backup`,
};

export const isApiPath = (pathname: string): boolean =>
  pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);

export const isGatewayPath = (pathname: string): boolean =>
  pathname === GATEWAY_PREFIX || pathname.startsWith(`${GATEWAY_PREFIX}/`);

export const ApiErrorBodySchema = v.object({
  error: v.object({
    code: v.string(),
    message: v.string(),
    issues: v.array(v.string()),
  }),
});

export const HealthSchema = v.object({
  ok: v.literal(true),
  migration: v.nullable(v.string()),
  duckMigration: v.nullable(v.string()),
});

export const BackupMemberSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

export const BackupManifestSchema = v.object({
  version: v.pipe(v.string(), v.minLength(1)),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  sqliteTag: v.nullable(v.string()),
  duckdbTag: v.nullable(v.string()),
  members: v.array(BackupMemberSchema),
});

export type ApiErrorBody = v.InferOutput<typeof ApiErrorBodySchema>;

export type Health = v.InferOutput<typeof HealthSchema>;

export type BackupMember = v.InferOutput<typeof BackupMemberSchema>;

export type BackupManifest = v.InferOutput<typeof BackupManifestSchema>;
