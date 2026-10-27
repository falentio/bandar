import { type AnyElysia, Elysia } from "elysia";
import { z } from "zod";
import { HealthSchema, type ApiErrorBody, type Health } from "../shared/api";
import { NoteIdSchema, NoteInputSchema, NoteListSchema, NoteSchema } from "../shared/notes";
import type { MigrationResult } from "./db/migrate";
import type { NotesRepo } from "./notes";

const NoteParamsSchema = z.object({ id: NoteIdSchema });

export function createApi(repo: NotesRepo, migration: MigrationResult): AnyElysia {
  // Elysia binds the error handler when a route is registered, so onError comes first.
  return new Elysia({ prefix: "/api" })
    .onError(({ code, error, path, set }) => {
      if (code === "VALIDATION") {
        set.status = 422;

        return failure(
          "validation",
          "request did not match the schema",
          error.all.map((issue) => `${issue.path}: ${issue.message}`),
        );
      }

      if (code === "NOT_FOUND") {
        set.status = 404;

        return failure("not_found", `no route for ${path}`);
      }

      console.error("api: unhandled error", error);
      set.status = 500;

      return failure("internal", "unexpected server error");
    })
    .get("/health", health(migration), { response: HealthSchema })
    .get("/notes", () => [...repo.list()], { response: NoteListSchema })
    .post(
      "/notes",
      ({ body, set }) => {
        set.status = 201;

        return repo.create(body);
      },
      { body: NoteInputSchema, response: NoteSchema },
    )
    .delete(
      "/notes/:id",
      ({ params, set }) => {
        if (!repo.remove(params.id)) {
          set.status = 404;

          return failure("not_found", `note ${params.id} not found`);
        }

        set.status = 204;
      },
      { params: NoteParamsSchema },
    );
}

function health(migration: MigrationResult): () => Health {
  return () => ({ ok: true, migration: migration.current });
}

function failure(code: string, message: string, issues: readonly string[] = []): ApiErrorBody {
  return { error: { code, message, issues: [...issues] } };
}
