import { z } from "zod";

export const NOTE_BODY_MAX = 500;

export const NoteInputSchema = z.object({
  body: z.string().trim().min(1).max(NOTE_BODY_MAX),
});

export const NoteSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  createdAt: z.string(),
});

export const NoteListSchema = z.array(NoteSchema);

export const NoteIdSchema = z.coerce.number().int().positive();

export type NoteInput = z.infer<typeof NoteInputSchema>;

export type Note = z.infer<typeof NoteSchema>;
