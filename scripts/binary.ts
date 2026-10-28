import { join } from "node:path";

export const BINARY = join(
  import.meta.dir,
  "..",
  "dist",
  process.platform === "win32" ? "bandar.exe" : "bandar",
);
