import { type z } from "zod";
import { ApiErrorBodySchema, HealthSchema, apiPaths } from "../shared/api";
import { NoteListSchema, NoteSchema, type Note, type NoteInput } from "../shared/notes";

export class ApiError extends Error {
  readonly status: number;
  readonly issues: readonly string[];

  constructor(status: number, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

export const notesApi = {
  list: (): Promise<Note[]> => request(apiPaths.notes, NoteListSchema),
  create: (input: NoteInput): Promise<Note> =>
    request(apiPaths.notes, NoteSchema, { method: "POST", body: JSON.stringify(input) }),
  remove: async (id: number): Promise<void> => {
    await send(apiPaths.note(id), { method: "DELETE" });
  },
  health: () => request(apiPaths.health, HealthSchema),
};

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init);

  return schema.parse(await response.json());
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, { ...init, headers });

  if (response.ok) return response;

  const payload: unknown = await response.json().catch(() => null);
  const parsed = ApiErrorBodySchema.safeParse(payload);

  if (!parsed.success)
    throw new ApiError(response.status, `request failed with ${response.status}`);

  throw new ApiError(response.status, parsed.data.error.message, parsed.data.error.issues);
}
