import { z } from "zod";

export const API_PREFIX = "/api";

export const apiPaths = {
  health: `${API_PREFIX}/health`,
  notes: `${API_PREFIX}/notes`,
  note: (id: number) => `${API_PREFIX}/notes/${id}`,
};

export const isApiPath = (pathname: string): boolean =>
  pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.string()),
  }),
});

export const HealthSchema = z.object({
  ok: z.literal(true),
  migration: z.string().nullable(),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export type Health = z.infer<typeof HealthSchema>;
