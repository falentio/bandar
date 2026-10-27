import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import * as v from "valibot";
import { ApiKeysPanel } from "./components/api-keys-panel";
import { AppShell } from "./components/app-shell";
import { AuthPage } from "./components/auth-page";
import { NotesPanel } from "./components/notes-panel";
import { SessionProvider, useSession } from "./use-session";
import { isViewPath } from "./views";

const loginSearch = v.object({
  redirect: v.optional(v.picklist(["/notes", "/api-keys"]), "/notes"),
});

type LoginSearch = v.InferOutput<typeof loginSearch>;

const rootRoute = createRootRoute({
  component: () => (
    <SessionProvider>
      <Outlet />
    </SessionProvider>
  ),
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/notes" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search): LoginSearch => {
    const parsed = v.safeParse(loginSearch, search);

    return parsed.success ? parsed.output : { redirect: "/notes" };
  },
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const notesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notes",
  component: NotesPanel,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/api-keys",
  component: ApiKeysPanel,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([notesRoute, apiKeysRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function LoginPage() {
  const auth = useSession();
  const search = loginRoute.useSearch();

  if (auth.status === "loading") return <SessionLoading />;

  if (auth.status === "signed-in") return <Navigate to={search.redirect} replace />;

  return <AuthPage auth={auth} />;
}

function AppLayout() {
  const auth = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (auth.status === "loading") return <SessionLoading />;

  if (auth.status === "signed-out") {
    // While the redirect is in flight the location already reads /login, and a
    // second Navigate rendered from that state would overwrite the redirect target.
    if (!isViewPath(pathname)) return <SessionLoading />;

    return <Navigate to="/login" search={{ redirect: pathname }} replace />;
  }

  return <AppShell email={auth.user.email} pending={auth.pending} onSignOut={auth.signOut} />;
}

function SessionLoading() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted">
      <p className="text-sm text-muted-foreground">Checking your session…</p>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 bg-muted">
      <p className="text-sm text-muted-foreground">This page does not exist.</p>
      <Link to="/notes" className="text-sm font-medium underline underline-offset-4">
        Back to notes
      </Link>
    </main>
  );
}
