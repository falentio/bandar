import {
  KeyRoundIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  ServerIcon,
  TagsIcon,
  TriangleAlertIcon,
} from "lucide-react";

export const views = [
  { to: "/overview", label: "Overview", icon: LayoutDashboardIcon },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/tags", label: "Tags", icon: TagsIcon },
  { to: "/requests", label: "Requests", icon: ScrollTextIcon },
  { to: "/errors", label: "Errors", icon: TriangleAlertIcon },
  { to: "/api-keys", label: "API keys", icon: KeyRoundIcon },
] as const;

export type View = (typeof views)[number];

export type ViewPath = View["to"];

export function isViewPath(path: string): path is ViewPath {
  return views.some((view) => view.to === path);
}

export function activeView(path: string): View | undefined {
  return views.find((view) => path === view.to || path.startsWith(`${view.to}/`));
}
