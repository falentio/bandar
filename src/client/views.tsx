import { KeyRoundIcon, StickyNoteIcon } from "lucide-react";

export const views = [
  { to: "/notes", label: "Notes", icon: StickyNoteIcon },
  { to: "/api-keys", label: "API keys", icon: KeyRoundIcon },
] as const;

export type View = (typeof views)[number];

export type ViewPath = View["to"];

export function isViewPath(path: string): path is ViewPath {
  return views.some((view) => view.to === path);
}
