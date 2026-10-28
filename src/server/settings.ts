import { join } from "node:path";
import * as v from "valibot";
import { MAX_PORT, MIN_PORT } from "../shared/topology";
import { SETTINGS_SCHEMA_FILE, SETTINGS_SCHEMA_REF, SETTINGS_SCHEMA_TEXT } from "./settings-schema";

const SETTINGS_FILE = "config.json";

// valibot reads a JSON array as an object with no keys, so an array would boot on defaults instead
// of naming the typo. This runs before strictObject, which only sees the keys it copies.
const notAnArray = v.custom((value) => !Array.isArray(value), "must hold an object");

const isWebUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;

  const { protocol } = new URL(value);

  return protocol === "http:" || protocol === "https:";
};

// An auth URL carries a path, so it stops here. v.url records its issue and still runs the next
// action, so a check after it must not throw on a value v.url already rejected.
export const HttpUrlSchema = v.pipe(
  v.string(),
  v.trim(),
  v.url(),
  v.check(isWebUrl, "must be an http or https URL"),
);

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
// origin: HTTPS://X.COM/ becomes https://x.com. The environment reads its list through this schema
// too, so a trailing slash cannot reach the browser check.
export const OriginSchema = v.pipe(
  HttpUrlSchema,
  v.check(isOrigin, "must be an origin such as https://llm.example.com, with no path"),
  v.transform((value) => new URL(value).origin),
);

const ServerSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    host: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(MIN_PORT), v.maxValue(MAX_PORT))),
    authUrl: v.optional(HttpUrlSchema),
    trustedOrigins: v.optional(
      v.pipe(v.array(OriginSchema), v.minLength(1, "needs at least one origin")),
    ),
  }),
);

export const SettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    $schema: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    server: v.optional(ServerSettingsSchema),
  }),
);

export type Settings = v.InferOutput<typeof SettingsSchema>;

export type SettingsRead =
  | { readonly kind: "ok"; readonly path: string; readonly settings: Settings }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string };

export const settingsPath = (home: string): string => join(home, SETTINGS_FILE);

export const settingsSchemaPath = (home: string): string => join(home, SETTINGS_SCHEMA_FILE);

/** The filesystem, injected so a test can hand over strings. */
export type SettingsIo = {
  readonly read: (path: string) => string;
  readonly write: (path: string, text: string) => void;
};

const isMissingFile = (error: unknown): error is Error =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Loads the settings through a caller-supplied io, so the caller owns the filesystem and a test can
 * hand over a string. A missing file is the normal state: every setting has a default. Every result
 * names the file, so a caller reports the path it actually opened. Loading writes: the schema lands
 * beside the file, and a file without a $schema key is pointed at it.
 */
export function loadSettings(home: string, io: SettingsIo): SettingsRead {
  const path = settingsPath(home);

  tryWrite(io, settingsSchemaPath(home), SETTINGS_SCHEMA_TEXT);

  let text: string;

  try {
    text = io.read(path);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing", path };

    return {
      kind: "invalid",
      path,
      reason: error instanceof Error ? error.message : "the reader threw without an error",
    };
  }

  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), SettingsSchema), text);

  if (parsed.success) {
    pointAtSchema(path, parsed.output, io);

    return { kind: "ok", path, settings: parsed.output };
  }

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

/**
 * The schema is generated, so it is written on every read: a document left by an older bandar
 * cannot drift from the binary beside it.
 */
function tryWrite(io: SettingsIo, path: string, text: string): void {
  try {
    io.write(path, text);
  } catch {
    // A data directory that is not writable only costs editor completion.
  }
}

/**
 * Adds the local schema reference to a file that lacks it, so an editor completes and checks the
 * file without a network. A $schema the operator wrote is left alone, and the file keeps its
 * settings: only the key is added.
 */
function pointAtSchema(path: string, settings: Settings, io: SettingsIo): void {
  if (settings.$schema !== undefined) return;

  tryWrite(io, path, JSON.stringify({ $schema: SETTINGS_SCHEMA_REF, ...settings }, null, 2) + "\n");
}
