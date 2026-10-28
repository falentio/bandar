import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SettingsIo } from "./settings";

/**
 * The settings filesystem for a real run. A write lands through a temp file beside the target and
 * a rename over it, so a crash mid-write leaves the operator's previous bytes in place. The
 * directory is created first, so a fresh BANDAR_HOME gets the schema on its first run.
 */
export const settingsIo: SettingsIo = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeBeside(path, text),
};

function writeBeside(path: string, text: string): void {
  const directory = dirname(path);

  mkdirSync(directory, { recursive: true });

  // The temp file lives beside the target so the rename stays within one filesystem.
  const temp = join(
    directory,
    `.${basename(path)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });

    throw error;
  }
}
