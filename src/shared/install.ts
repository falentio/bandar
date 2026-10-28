import * as v from "valibot";

export const INSTALL_SOURCES = ["install-script", "manual", "unknown"] as const;

export const InstallSourceSchema = v.picklist(INSTALL_SOURCES);

export const InstallManifestSchema = v.object({
  source: InstallSourceSchema,
  version: v.pipe(v.string(), v.minLength(1)),
  path: v.pipe(v.string(), v.check(isAbsolutePath, "must be an absolute path")),
});

export const installPaths = {
  manifest: "install.json",
};

// tsconfig.app.json type-checks src/shared with node types off, so this file stays free of node
// builtins: node reads a forward slash on every platform, and install.sh writes the same one.
export const installManifestPath = (configDir: string): string =>
  `${configDir.replace(/[\\/]+$/u, "")}/${installPaths.manifest}`;

export type InstallSource = v.InferOutput<typeof InstallSourceSchema>;

export type InstallManifest = v.InferOutput<typeof InstallManifestSchema>;

export type InstallManifestRead =
  | { readonly kind: "ok"; readonly manifest: InstallManifest }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string };

function isAbsolutePath(value: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/u.test(value);
}

const isMissingFile = (error: unknown): error is Error =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads the manifest through a caller-supplied reader, so the caller owns the filesystem and a
 * test can hand over a string. A missing file is a normal state: the install source is unknown.
 */
export function readInstallManifest(
  configDir: string,
  read: (path: string) => string,
): InstallManifestRead {
  let text: string;

  try {
    text = read(installManifestPath(configDir));
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing" };

    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "the reader threw without an error",
    };
  }

  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), InstallManifestSchema), text);

  if (parsed.success) return { kind: "ok", manifest: parsed.output };

  return {
    kind: "invalid",
    reason: parsed.issues
      .map((issue) => {
        const field = issue.path?.map((item) => String(item.key)).join(".") ?? "";

        return field === "" ? issue.message : `${field}: ${issue.message}`;
      })
      .join("; "),
  };
}
