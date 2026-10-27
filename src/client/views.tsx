import { KeyRoundIcon, LayoutDashboardIcon, ScrollTextIcon, ServerIcon } from "lucide-react";

export const views = [
  { to: "/overview", label: "Overview", icon: LayoutDashboardIcon },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/requests", label: "Requests", icon: ScrollTextIcon },
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
