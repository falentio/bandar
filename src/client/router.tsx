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
import { ErrorsPanel } from "./components/errors-panel";
import { OverviewPanel } from "./components/overview-panel";
import { isProviderTab, ProviderPage } from "./components/provider-page";
import { ProvidersPanel } from "./components/providers-panel";
import { RequestsPanel } from "./components/requests-panel";
import { TagsPanel } from "./components/tags-panel";
import { SessionProvider, useSession } from "./use-session";
import { isViewPath } from "./views";

const loginSearch = v.object({
  redirect: v.optional(
    v.picklist(["/overview", "/providers", "/tags", "/requests", "/errors", "/api-keys"]),
    "/overview",
  ),
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
    throw redirect({ to: "/overview" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search): LoginSearch => {
    const parsed = v.safeParse(loginSearch, search);

    return parsed.success ? parsed.output : { redirect: "/overview" };
  },
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/overview",
  component: OverviewPanel,
});

const providersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/providers",
  component: ProvidersPanel,
});

const providerTabSearch = v.object({
  tab: v.optional(v.picklist(["overview", "settings", "models", "credentials"]), "overview"),
});

const providerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/providers/$providerId",
  validateSearch: (search): v.InferOutput<typeof providerTabSearch> => {
    const parsed = v.safeParse(providerTabSearch, search);

    return parsed.success ? parsed.output : { tab: "overview" };
  },
  component: ProviderDetailRoute,
});

const requestsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/requests",
  component: RequestsPanel,
});

const errorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/errors",
  component: ErrorsPanel,
});

const tagsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tags",
  component: TagsPanel,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/api-keys",
  component: ApiKeysPanel,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([
    overviewRoute,
    providersRoute,
    providerRoute,
    tagsRoute,
    requestsRoute,
    errorsRoute,
    apiKeysRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function ProviderDetailRoute() {
  const { providerId } = providerRoute.useParams();
  const { tab } = providerRoute.useSearch();
  const navigate = providerRoute.useNavigate();

  return (
    <ProviderPage
      providerId={providerId}
      tab={tab}
      onTabChange={(next) => {
        if (!isProviderTab(next)) return;

        void navigate({ search: { tab: next }, replace: true });
      }}
      onRemoved={() => void navigate({ to: "/providers" })}
    />
  );
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
      <Link to="/overview" className="text-sm font-medium underline underline-offset-4">
        Back to overview
      </Link>
    </main>
  );
}
