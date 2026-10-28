import { notImplemented, type Commands } from "./command";

// Filled by the update unit.
export function register(commands: Commands): void {
  commands.add({
    name: "update",
    summary: "replace this binary with the latest release",
    run: () => notImplemented("update"),
  });
}
