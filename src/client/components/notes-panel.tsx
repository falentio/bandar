import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NOTE_BODY_MAX } from "@/shared/notes";
import { useNotes } from "../use-notes";

export function NotesPanel() {
  const notes = useNotes();
  const [body, setBody] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();

    if (!trimmed) return;

    setBody("");
    await notes.add(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
        <CardDescription>
          Every note makes the round trip: browser, Elysia, Drizzle, SQLite, and back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={NOTE_BODY_MAX}
            placeholder="Write a note"
            aria-label="Note body"
            disabled={notes.pending}
          />
          <Button type="submit" disabled={notes.pending || body.trim() === ""}>
            Add
          </Button>
        </form>

        {notes.status === "loading" ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading notes…</p>
        ) : null}

        {notes.status === "error" ? (
          <p className="mt-6 text-sm text-destructive">{notes.message}</p>
        ) : null}

        {notes.status === "ready" && notes.notes.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No notes yet.</p>
        ) : null}

        {notes.status === "ready" ? (
          <ul className="mt-6 divide-y">
            {notes.notes.map((note) => (
              <li key={note.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm break-words">{note.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(note.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={notes.pending}
                  onClick={() => void notes.remove(note.id)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
