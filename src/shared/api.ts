import * as v from "valibot";

export const API_PREFIX = "/api";

export const apiPaths = {
  health: `${API_PREFIX}/health`,
  notes: `${API_PREFIX}/notes`,
  note: (id: number) => `${API_PREFIX}/notes/${id}`,
};

export const isApiPath = (pathname: string): boolean =>
  pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);

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
});

export type ApiErrorBody = v.InferOutput<typeof ApiErrorBodySchema>;

export type Health = v.InferOutput<typeof HealthSchema>;
