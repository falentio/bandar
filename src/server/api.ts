import { type AnyElysia, Elysia } from "elysia";
import * as v from "valibot";
import { HealthSchema, type ApiErrorBody, type Health } from "../shared/api";
import { NoteIdSchema, NoteInputSchema } from "../shared/notes";
import type { Auth, SessionUser } from "./auth";
import type { MigrationResult } from "./db/migrate";
import type { NotesRepo } from "./notes";
import { InputError, parseInput, type ParseableInput } from "./validation";

const NoteParamsSchema = v.object({ id: NoteIdSchema });

export function createApi(repo: NotesRepo, migration: MigrationResult, auth: Auth): AnyElysia {
  // Elysia binds the error handler when a route is registered, so onError comes first.
  return new Elysia({ prefix: "/api" })
    .onError(({ code, error, path, set }) => {
      if (error instanceof InputError) {
        set.status = 422;

        return failure("validation", "request did not match the schema", error.issues);
      }

      if (code === "NOT_FOUND") {
        set.status = 404;

        return failure("not_found", `no route for ${path}`);
      }

      console.error("api: unhandled error", error);
      set.status = 500;

      return failure("internal", "unexpected server error");
    })
    .all("/auth/*", ({ request }) => auth.handler(request))
    .get("/health", health(migration), { response: HealthSchema })
    .get("/notes", async ({ request }) => {
      const user = await requireSession(auth, request);

      if (user instanceof Response) return user;

      return [...repo.list(user.id)];
    })
    .post("/notes", async ({ body, request, set }) => {
      const user = await requireSession(auth, request);

      if (user instanceof Response) return user;

      // SAFETY: Elysia parses the JSON body before the handler runs; anything else is a 400.
      const input = parseInput(NoteInputSchema, body as ParseableInput);

      set.status = 201;

      return repo.create(user.id, input);
    })
    .delete("/notes/:id", async ({ params, request, set }) => {
      const user = await requireSession(auth, request);

      if (user instanceof Response) return user;

      const { id } = parseInput(NoteParamsSchema, params);

      if (!repo.remove(user.id, id)) {
        set.status = 404;

        return failure("not_found", `note ${id} not found`);
      }

      set.status = 204;
    });
}

function health(migration: MigrationResult): () => Health {
  return () => ({ ok: true, migration: migration.current });
}

async function requireSession(auth: Auth, request: Request): Promise<SessionUser | Response> {
  const user = await auth.getSession(request.headers);

  return user ?? Response.json(failure("unauthorized", "sign in to use notes"), { status: 401 });
}

function failure(code: string, message: string, issues: readonly string[] = []): ApiErrorBody {
  return { error: { code, message, issues: [...issues] } };
}
