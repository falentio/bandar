import { join } from "node:path";
import * as v from "valibot";
import { MAX_PORT, MIN_PORT } from "../shared/topology";

const SETTINGS_FILE = "config.json";

// valibot reads a JSON array as an object with no keys, so an array would boot on defaults instead
// of naming the typo. This runs before strictObject, which only sees the keys it copies.
const notAnArray = v.custom((value) => !Array.isArray(value), "must hold an object");

const UrlSchema = v.pipe(v.string(), v.trim(), v.url());

// v.url records its issue and still runs the next action, so this check must not throw on a value
// v.url already rejected.
const isOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);

  return (
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
};

// A browser compares an origin by scheme, host, and port, so the stored form is the URL's own
// origin: HTTPS://X.COM/ becomes https://x.com.
const OriginSchema = v.pipe(
  UrlSchema,
  v.check(isOrigin, "must be an origin such as https://llm.example.com, with no path"),
  v.transform((value) => new URL(value).origin),
);

const ServerSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    host: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(MIN_PORT), v.maxValue(MAX_PORT))),
    authUrl: v.optional(UrlSchema),
    trustedOrigins: v.optional(
      v.pipe(v.array(OriginSchema), v.minLength(1, "needs at least one origin")),
    ),
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
  | { readonly kind: "ok"; readonly path: string; readonly settings: Settings }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string };

export const settingsPath = (home: string): string => join(home, SETTINGS_FILE);

const isMissingFile = (error: unknown): error is Error =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads the settings through a caller-supplied reader, so the caller owns the filesystem and a
 * test can hand over a string. A missing file is the normal state: every setting has a default.
 * Every result names the file, so a caller reports the path it actually opened.
 */
export function readSettings(home: string, read: (path: string) => string): SettingsRead {
  const path = settingsPath(home);
  let text: string;

  try {
    text = read(path);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing", path };

    return {
      kind: "invalid",
      path,
      reason: error instanceof Error ? error.message : "the reader threw without an error",
    };
  }

  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), SettingsSchema), text);

  if (parsed.success) return { kind: "ok", path, settings: parsed.output };

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
