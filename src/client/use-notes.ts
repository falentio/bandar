import { useCallback, useEffect, useState } from "react";
import type { Note } from "../shared/notes";
import { ApiError, notesApi } from "./api";

export type NotesState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly notes: readonly Note[] };

export type Notes = NotesState & {
  readonly pending: boolean;
  readonly add: (body: string) => Promise<void>;
  readonly remove: (id: number) => Promise<void>;
};

export function useNotes(): Notes {
  const [state, setState] = useState<NotesState>({ status: "loading" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const notes = await notesApi.list();

        if (live) setState({ status: "ready", notes });
      } catch (error) {
        if (live)
          setState({ status: "error", message: isError(error) ? describe(error) : String(error) });
      }
    };

    void load();

    return () => {
      live = false;
    };
  }, []);

  const add = useCallback(async (body: string) => {
    setPending(true);

    try {
      const note = await notesApi.create({ body });
      setState((current) => ({
        status: "ready",
        notes: [note, ...(current.status === "ready" ? current.notes : [])],
      }));
    } catch (error) {
      setState({ status: "error", message: isError(error) ? describe(error) : String(error) });
    } finally {
      setPending(false);
    }
  }, []);

  const remove = useCallback(async (id: number) => {
    setPending(true);

    try {
      await notesApi.remove(id);
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", notes: current.notes.filter((note) => note.id !== id) }
          : current,
      );
    } catch (error) {
      setState({ status: "error", message: isError(error) ? describe(error) : String(error) });
    } finally {
      setPending(false);
    }
  }, []);

  return { ...state, pending, add, remove };
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

function describe(error: Error): string {
  return error instanceof ApiError ? (error.issues[0] ?? error.message) : error.message;
}
