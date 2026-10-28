import { notImplemented, type Commands } from "./command";

// Filled by the backup unit.
export function register(commands: Commands): void {
  commands.add({
    name: "backup",
    summary: "back up the SQLite and DuckDB databases",
    run: () => notImplemented("backup"),
  });
}
