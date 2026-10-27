import * as v from "valibot";

export const NOTE_BODY_MAX = 500;

export const NoteInputSchema = v.object({
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(NOTE_BODY_MAX)),
});

export const NoteSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: v.string(),
  createdAt: v.string(),
});

export const NoteListSchema = v.array(NoteSchema);

export const NoteIdSchema = v.pipe(
  v.string(),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(1),
);

export type NoteInput = v.InferOutput<typeof NoteInputSchema>;

export type Note = v.InferOutput<typeof NoteSchema>;
