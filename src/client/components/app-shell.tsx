import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { activeView } from "../views";
import { AppSidebar } from "./app-sidebar";

export function AppShell({
  email,
  pending,
  onSignOut,
}: {
  email: string;
  pending: boolean;
  onSignOut: () => Promise<void>;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeView(pathname);

  return (
    <SidebarProvider>
      <AppSidebar email={email} pending={pending} onSignOut={onSignOut} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>bandar</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {current === undefined ? (
                    <BreadcrumbPage>Provider</BreadcrumbPage>
                  ) : pathname === current.to ? (
                    <BreadcrumbPage>{current.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={current.to}>{current.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 pt-0">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
