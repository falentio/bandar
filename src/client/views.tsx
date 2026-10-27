import { KeyRoundIcon, StickyNoteIcon } from "lucide-react";
import { ApiKeysPanel } from "./components/api-keys-panel";
import { NotesPanel } from "./components/notes-panel";

export const views = [
  { id: "notes", label: "Notes", icon: StickyNoteIcon, Panel: NotesPanel },
  { id: "api-keys", label: "API keys", icon: KeyRoundIcon, Panel: ApiKeysPanel },
] as const;

export type View = (typeof views)[number];
