import { notImplemented, type Commands } from "./command";

// Filled by the install-service unit.
export function register(commands: Commands): void {
  commands.add({
    name: "install-service",
    summary: "install bandar as a system service",
    run: () => notImplemented("install-service"),
  });

  commands.add({
    name: "uninstall-service",
    summary: "remove the bandar system service",
    run: () => notImplemented("uninstall-service"),
  });
}
