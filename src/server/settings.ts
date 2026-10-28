import { join } from "node:path";
import * as v from "valibot";
import { MAX_PORT, MIN_PORT } from "../shared/topology";

const SETTINGS_FILE = "config.json";

// valibot reads a JSON array as an object with no keys, so an array would boot on defaults instead
// of naming the typo. This runs before strictObject, which only sees the keys it copies.
const notAnArray = v.custom((value) => !Array.isArray(value), "must hold an object");

const ServerSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    host: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(MIN_PORT), v.maxValue(MAX_PORT))),
  }),
);

export const SettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    server: v.optional(ServerSettingsSchema),
  }),
);

export type Settings = v.InferOutput<typeof SettingsSchema>;

export type SettingsRead =
  | { readonly kind: "ok"; readonly settings: Settings }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string };

export const settingsPath = (home: string): string => join(home, SETTINGS_FILE);

const isMissingFile = (error: unknown): error is Error =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads the settings through a caller-supplied reader, so the caller owns the filesystem and a
 * test can hand over a string. A missing file is the normal state: every setting has a default.
 * An invalid result names the file it read, so the caller reports the path it actually opened.
 */
export function readSettings(home: string, read: (path: string) => string): SettingsRead {
  const path = settingsPath(home);
  let text: string;

  try {
    text = read(path);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing" };

    return {
      kind: "invalid",
      path,
      reason: error instanceof Error ? error.message : "the reader threw without an error",
    };
  }

  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), SettingsSchema), text);

  if (parsed.success) return { kind: "ok", settings: parsed.output };

  return {
    kind: "invalid",
    path,
    reason: parsed.issues
      .map((issue) => {
        const field = issue.path?.map((item) => String(item.key)).join(".") ?? "";

        return field === "" ? issue.message : `${field}: ${issue.message}`;
      })
      .join("; "),
  };
}
