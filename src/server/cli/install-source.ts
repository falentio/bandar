import { readInstallManifest, type InstallManifest } from "../../shared/install";

export type InstallState =
  | { readonly kind: "reported"; readonly manifest: InstallManifest }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Decides whether this copy recorded an install source that permits self-update. install.sh is the
 * only writer of install.json, so a missing or unreadable manifest is the same signal as a source
 * of "unknown": the binary belongs to someone else.
 */
export function detectInstall(configDir: string, read: (path: string) => string): InstallState {
  const report = readInstallManifest(configDir, read);

  if (report.kind === "ok") {
    if (report.manifest.source === "unknown")
      return { kind: "unknown", reason: "install.json records the source as unknown" };

    return { kind: "reported", manifest: report.manifest };
  }

  return {
    kind: "unknown",
    reason:
      report.kind === "missing"
        ? "no install.json records an install source"
        : `install.json is unreadable (${report.reason})`,
  };
}
