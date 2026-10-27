import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { type View, views } from "../views";
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
  const [activeView, setActiveView] = useState<View>(views[0]);
  const ActivePanel = activeView.Panel;

  return (
    <SidebarProvider>
      <AppSidebar
        email={email}
        pending={pending}
        onSignOut={onSignOut}
        activeView={activeView}
        onSelect={setActiveView}
      />
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
                  <BreadcrumbPage>{activeView.label}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 pt-0">
          <ActivePanel />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
