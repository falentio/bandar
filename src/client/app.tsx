import { AppShell } from "./components/app-shell";
import { AuthPage } from "./components/auth-page";
import { useSession } from "./use-session";

export function App() {
  const auth = useSession();

  if (auth.status === "loading") {
    return (
      <main className="flex min-h-svh items-center justify-center bg-muted">
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </main>
    );
  }

  if (auth.status === "signed-out") return <AuthPage auth={auth} />;

  return <AppShell email={auth.user.email} pending={auth.pending} onSignOut={auth.signOut} />;
}
