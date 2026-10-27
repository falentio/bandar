import { NotesPanel } from "./components/notes-panel";

export function App() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">bandar</h1>
        <p className="text-muted-foreground">
          One compiled binary carrying a React client, an Elysia API, and its SQLite migrations.
        </p>
      </header>
      <NotesPanel />
    </main>
  );
}
