import { Button } from "@/components/ui/button";
import { ApiKeysPanel } from "./components/api-keys-panel";
import { AuthPanel } from "./components/auth-panel";
import { NotesPanel } from "./components/notes-panel";
import { useSession } from "./use-session";

export function App() {
  const auth = useSession();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">bandar</h1>
        <p className="text-muted-foreground">
          One compiled binary carrying a React client, an Elysia API, and its SQLite migrations.
        </p>
      </header>

      {auth.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      ) : null}

      {auth.status === "signed-out" ? <AuthPanel auth={auth} /> : null}

      {auth.status === "signed-in" ? (
        <>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{auth.user.email}</p>
            <Button
              variant="ghost"
              size="sm"
              disabled={auth.pending}
              onClick={() => void auth.signOut()}
            >
              Sign out
            </Button>
          </div>
          <NotesPanel />
          <ApiKeysPanel />
        </>
      ) : null}
    </main>
  );
}
