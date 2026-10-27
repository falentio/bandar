import { and, desc, eq } from "drizzle-orm";
import type { Note, NoteInput } from "../shared/notes";
import type { Db } from "./db/client";
import { notes, type NoteRow } from "./db/schema";

const LIST_LIMIT = 100;

export type NotesRepo = {
  readonly list: (userId: string) => readonly Note[];
  readonly create: (userId: string, input: NoteInput) => Note;
  readonly remove: (userId: string, id: number) => boolean;
};

export function createNotesRepo(db: Db): NotesRepo {
  return {
    list: (userId) =>
      db
        .select()
        .from(notes)
        .where(eq(notes.userId, userId))
        .orderBy(desc(notes.id))
        .limit(LIST_LIMIT)
        .all()
        .map(toNote),
    create: (userId, input) =>
      toNote(
        db
          .insert(notes)
          .values({ userId, body: input.body, createdAt: new Date() })
          .returning()
          .get(),
      ),
    remove: (userId, id) =>
      db
        .delete(notes)
        .where(and(eq(notes.id, id), eq(notes.userId, userId)))
        .returning({ id: notes.id })
        .all().length > 0,
  };
}

function toNote(row: NoteRow): Note {
  return { id: row.id, body: row.body, createdAt: row.createdAt.toISOString() };
}
