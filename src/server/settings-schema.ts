import {
  authUrlForPort,
  DEFAULT_API_PORT,
  DEFAULT_HOST,
  MAX_PORT,
  MIN_PORT,
} from "../shared/topology";

export const SETTINGS_SCHEMA_FILE = "config.schema.json";

export const SETTINGS_SCHEMA_REF = `./${SETTINGS_SCHEMA_FILE}`;

/**
 * What an editor needs to complete and check config.json. The server stays stricter than this
 * document in one place: an origin carrying credentials matches the pattern but fails the boot.
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
      description: `Set to "${SETTINGS_SCHEMA_REF}" by bandar when the file lacks it.`,
    },
    server: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: {
          type: "string",
          minLength: 1,
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
          pattern: "^https?://",
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
            pattern: "^https?://[^/?#]+/?$",
            description: "An origin with no path, query, fragment, or credentials.",
          },
        },
      },
    },
  },
} as const;

export const SETTINGS_SCHEMA_TEXT = `${JSON.stringify(settingsSchema, null, 2)}\n`;
