import { toJsonSchema } from "@valibot/to-json-schema";
import { join } from "node:path";
import * as v from "valibot";
import { DEFAULT_API_PORT, MAX_PORT, MIN_PORT } from "../shared/topology";
import { PROVIDER_ENDPOINT_SPECS, type EndpointSpec } from "./providers/endpoints";

const SETTINGS_FILE = "config.json";

export const SETTINGS_SCHEMA_FILE = "config.schema.json";

export const SETTINGS_SCHEMA_REF = `./${SETTINGS_SCHEMA_FILE}`;

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
  v.description("An origin with no path, query, fragment, or credentials."),
);

const ServerSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    host: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.description("The interface to listen on. Defaults to 0.0.0.0."),
      ),
    ),
    port: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(MIN_PORT),
        v.maxValue(MAX_PORT),
        v.description("The port to listen on. Defaults to " + String(DEFAULT_API_PORT) + "."),
      ),
    ),
    authUrl: v.optional(
      v.pipe(
        HttpUrlSchema,
        v.description("The public URL of this server. Defaults to http://localhost:<port>."),
      ),
    ),
    trustedOrigins: v.optional(
      v.pipe(
        v.array(OriginSchema),
        v.minLength(1, "needs at least one origin"),
        v.description(
          "Origins allowed to sign in. Defaults to the auth URL's origin and the loopback.",
        ),
      ),
    ),
  }),
);

const endpointField = (spec: EndpointSpec) =>
  v.optional(v.pipe(HttpUrlSchema, v.description(spec.description)));

const KilocodeSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.kilocode.baseUrl),
    catalogUrl: endpointField(PROVIDER_ENDPOINT_SPECS.kilocode.catalogUrl),
  }),
);

const TokenharborSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({ baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.tokenharbor.baseUrl) }),
);

const YetaSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({ baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.yeta.baseUrl) }),
);

const RiverSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.river.baseUrl),
    catalogUrl: endpointField(PROVIDER_ENDPOINT_SPECS.river.catalogUrl),
  }),
);

const NousSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.nous.baseUrl),
    authUrl: endpointField(PROVIDER_ENDPOINT_SPECS.nous.authUrl),
  }),
);

const HyperSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({ baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.hyper.baseUrl) }),
);

const OpenCodeSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({ baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.opencode.baseUrl) }),
);

const ZroSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({ baseUrl: endpointField(PROVIDER_ENDPOINT_SPECS.zro.baseUrl) }),
);

const UpdateSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    webUrl: v.optional(
      v.pipe(
        HttpUrlSchema,
        v.description("The release web base for downloads. Defaults to the public repository."),
      ),
    ),
    apiUrl: v.optional(
      v.pipe(
        HttpUrlSchema,
        v.description(
          "The latest-release feed of a private fork. Absent: the public release page.",
        ),
      ),
    ),
  }),
);

const ProvidersSettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    kilocode: v.optional(KilocodeSettingsSchema),
    tokenharbor: v.optional(TokenharborSettingsSchema),
    yeta: v.optional(YetaSettingsSchema),
    river: v.optional(RiverSettingsSchema),
    nous: v.optional(NousSettingsSchema),
    hyper: v.optional(HyperSettingsSchema),
    opencode: v.optional(OpenCodeSettingsSchema),
    zro: v.optional(ZroSettingsSchema),
  }),
);

export const SettingsSchema = v.pipe(
  notAnArray,
  v.strictObject({
    $schema: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.description('Set to "' + SETTINGS_SCHEMA_REF + '" by bandar when the file lacks it.'),
      ),
    ),
    server: v.optional(ServerSettingsSchema),
    providers: v.optional(ProvidersSettingsSchema),
    update: v.optional(UpdateSettingsSchema),
  }),
  v.metadata({
    title: "bandar config.json",
    description: "Runtime settings read from $BANDAR_HOME/config.json.",
  }),
);

// The document is derived from the parser, so its keys, types, and bounds cannot drift from the
// boot check. What JSON Schema cannot express, which is the URL grammar behind an origin, is
// enforced at boot alone, so an editor is more permissive than the server in that one place.
export const settingsSchema = toJsonSchema(SettingsSchema, { errorMode: "ignore" });

export const SETTINGS_SCHEMA_TEXT = JSON.stringify(settingsSchema, null, 2) + "\n";

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
    pointAtSchema(path, text, parsed.output, io);

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

const SCHEMA_KEY = `"$schema": ${JSON.stringify(SETTINGS_SCHEMA_REF)}`;

/**
 * Adds the local schema reference to a file that lacks it, so an editor completes and checks the
 * file without a network. A $schema the operator wrote is left alone, and every other byte of the
 * file stays as written: the key goes in right after the first brace, holding the indent of the
 * key that follows it.
 */
function pointAtSchema(path: string, text: string, settings: Settings, io: SettingsIo): void {
  if (settings.$schema !== undefined) return;

  const pointed = withSchemaKey(text);

  if (pointed !== null) tryWrite(io, path, pointed);
}

function withSchemaKey(text: string): string | null {
  const open = text.indexOf("{");

  if (open === -1) return null;

  const body = text.slice(open + 1);
  const indent = /^\s*/u.exec(body)?.[0] ?? "";
  const empty = body.slice(0, body.lastIndexOf("}")).trim() === "";

  return `${text.slice(0, open + 1)}${indent}${SCHEMA_KEY}${empty ? "" : ","}${body}`;
}
