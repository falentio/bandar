import * as v from "valibot";

export const API_PREFIX = "/api";
export const GATEWAY_PREFIX = "/v1";

export const apiPaths = {
  health: `${API_PREFIX}/health`,
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

export type ApiErrorBody = v.InferOutput<typeof ApiErrorBodySchema>;

export type Health = v.InferOutput<typeof HealthSchema>;
