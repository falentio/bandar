import { Link, useRouterState } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { activeView, views } from "../views";

export function NavMain() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeView(pathname);
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarMenu>
        {views.map((view) => (
          <SidebarMenuItem key={view.to}>
            <SidebarMenuButton asChild isActive={view === current} tooltip={view.label}>
              <Link to={view.to} onClick={() => setOpenMobile(false)}>
                <view.icon />
                <span>{view.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
