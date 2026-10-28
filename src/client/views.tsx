import {
  KeyRoundIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  ServerIcon,
  TagsIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";

export const views = [
  { to: "/overview", label: "Overview", icon: LayoutDashboardIcon },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/tags", label: "Tags", icon: TagsIcon },
  { to: "/requests", label: "Requests", icon: ScrollTextIcon },
  { to: "/errors", label: "Errors", icon: TriangleAlertIcon },
  { to: "/api-keys", label: "API keys", icon: KeyRoundIcon },
  { to: "/cli-tools", label: "CLI tools", icon: TerminalIcon },
] as const;

export type View = (typeof views)[number];

export type ViewPath = View["to"];

// The model row harness is a scratch page inside the app shell, not a workspace view.
const HARNESS_PATHS = ["/harness/model-row"] as const;

export function isViewPath(path: string): path is ViewPath {
  return views.some((view) => view.to === path) || HARNESS_PATHS.some((p) => p === path);
}

/** Where to send someone after signing in. A detail page keeps its list page. */
export function redirectTarget(path: string): ViewPath | undefined {
  return activeView(path)?.to ?? (isViewPath(path) ? path : undefined);
}

export function activeView(path: string): View | undefined {
  return views.find((view) => path === view.to || path.startsWith(`${view.to}/`));
}
