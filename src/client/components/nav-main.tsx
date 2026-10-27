import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { type View, views } from "../views";

export function NavMain({
  activeView,
  onSelect,
}: {
  activeView: View;
  onSelect: (view: View) => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarMenu>
        {views.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              isActive={item.id === activeView.id}
              tooltip={item.label}
              onClick={() => onSelect(item)}
            >
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
