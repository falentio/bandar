import { desc, eq } from "drizzle-orm";
import type { Note, NoteInput } from "../shared/notes";
import type { Db } from "./db/client";
import { notes, type NoteRow } from "./db/schema";

const LIST_LIMIT = 100;

export type NotesRepo = {
  readonly list: () => readonly Note[];
  readonly create: (input: NoteInput) => Note;
  readonly remove: (id: number) => boolean;
};

export function createNotesRepo(db: Db): NotesRepo {
  return {
    list: () => db.select().from(notes).orderBy(desc(notes.id)).limit(LIST_LIMIT).all().map(toNote),
    create: (input) =>
      toNote(
        db.insert(notes).values({ body: input.body, createdAt: new Date() }).returning().get(),
      ),
    remove: (id) =>
      db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id }).all().length > 0,
  };
}

function toNote(row: NoteRow): Note {
  return { id: row.id, body: row.body, createdAt: row.createdAt.toISOString() };
}
