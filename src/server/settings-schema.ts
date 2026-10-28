import {
  authUrlForPort,
  DEFAULT_API_PORT,
  DEFAULT_HOST,
  MAX_PORT,
  MIN_PORT,
} from "../shared/topology";

export const SETTINGS_SCHEMA_FILE = "config.schema.json";

export const SETTINGS_SCHEMA_REF = `./${SETTINGS_SCHEMA_FILE}`;

// A JSON Schema pattern has no inline flag to make it case insensitive, and the parser compares the
// scheme only after the URL API has lowercased it, so the scheme is spelled out.
const SCHEME = "[hH][tT][tT][pP][sS]?://";

// A host with an optional numeric port. Brackets hold an IPv6 literal, which carries its own colons.
const AUTHORITY = "(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9._~%!$&'()*+,;=-]+)(?::\\d+)?";

const AUTH_URL_PATTERN = `^${SCHEME}(?:[^\\s/?#@]+@)?${AUTHORITY}(?:[/?#].*)?$`;

const ORIGIN_PATTERN = `^${SCHEME}${AUTHORITY}/?$`;

/**
 * What an editor needs to complete and check config.json. These rules cannot express everything the
 * parser checks: a pattern cannot trim, so a value with surrounding whitespace fails here and still
 * boots, and the host and scheme grammar is written out by hand. ./settings-schema.test.ts runs every
 * document through both and pins the one gap that is left.
 */
export const settingsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "bandar config.json",
  description: "Web server settings read from $BANDAR_HOME/config.json.",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: {
      type: "string",
      pattern: "\\S",
      description: `Set to "${SETTINGS_SCHEMA_REF}" by bandar when the file lacks it.`,
    },
    server: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: {
          type: "string",
          pattern: "\\S",
          description: `The interface to listen on. Defaults to ${DEFAULT_HOST}.`,
        },
        port: {
          type: "integer",
          minimum: MIN_PORT,
          maximum: MAX_PORT,
          description: `The port to listen on. Defaults to ${String(DEFAULT_API_PORT)}.`,
        },
        authUrl: {
          type: "string",
          format: "uri",
          pattern: AUTH_URL_PATTERN,
          description: `The public URL of this server. Defaults to ${authUrlForPort("<port>")}.`,
        },
        trustedOrigins: {
          type: "array",
          minItems: 1,
          description:
            "Origins allowed to sign in. Defaults to the auth URL's origin and the loopback.",
          items: {
            type: "string",
            format: "uri",
            pattern: ORIGIN_PATTERN,
            description: "An origin with no path, query, fragment, or credentials.",
          },
        },
      },
    },
  },
} as const;

export const SETTINGS_SCHEMA_TEXT = `${JSON.stringify(settingsSchema, null, 2)}\n`;
