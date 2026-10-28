import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_API_PORT, MAX_PORT, MIN_PORT } from "../shared/topology";
import { SETTINGS_SCHEMA_TEXT, settingsSchema } from "./settings";

// The generated document is parsed before it is read, so a keyword this test does not expect fails
// here rather than sliding past an assertion that only checks the keys it happens to know.
const Property = v.looseObject({ description: v.string() });

const GeneratedSchema = v.strictObject({
  $schema: v.string(),
  type: v.literal("object"),
  title: v.string(),
  description: v.string(),
  additionalProperties: v.literal(false),
  required: v.array(v.string()),
  properties: v.strictObject({
    $schema: Property,
    server: v.strictObject({
      type: v.literal("object"),
      additionalProperties: v.literal(false),
      required: v.array(v.string()),
      properties: v.strictObject({
        host: Property,
        port: v.looseObject({
          type: v.literal("integer"),
          minimum: v.number(),
          maximum: v.number(),
          description: v.string(),
        }),
        authUrl: Property,
        trustedOrigins: Property,
      }),
    }),
  }),
});

const document = v.parse(GeneratedSchema, settingsSchema);

const server = document.properties.server.properties;

describe("the generated schema", () => {
  test("it names the document", () => {
    expect(document.$schema).toContain("json-schema.org");
    expect(document.title).toBe("bandar config.json");
    expect(document.description).toContain("BANDAR_HOME");
  });

  test("it lists the keys the parser reads, and no others", () => {
    expect(Object.keys(document.properties)).toEqual(["$schema", "server"]);
    expect(Object.keys(server)).toEqual(["host", "port", "authUrl", "trustedOrigins"]);
  });

  test("every key is optional, as the parser has it", () => {
    expect(document.required).toEqual([]);
    expect(document.properties.server.required).toEqual([]);
  });

  test("the port bounds come from the shared constants", () => {
    expect(server.port.minimum).toBe(MIN_PORT);
    expect(server.port.maximum).toBe(MAX_PORT);
  });

  test("each key carries the help an editor shows", () => {
    for (const [name, property] of Object.entries({
      ...server,
      $schema: document.properties.$schema,
    }))
      expect(property.description, name).toEqual(expect.any(String));
  });

  test("the port default in the help comes from the constant", () => {
    expect(server.port.description).toContain(String(DEFAULT_API_PORT));
  });

  test("the text written beside the settings is the document", () => {
    expect(JSON.parse(SETTINGS_SCHEMA_TEXT)).toEqual(document);
    expect(SETTINGS_SCHEMA_TEXT.endsWith("\n")).toBe(true);
  });
});
