import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { BUILT_IN_PROVIDER_KINDS } from "../shared/providers";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, MAX_PORT, MIN_PORT } from "../shared/topology";
import { SETTINGS_SCHEMA_TEXT, settingsSchema } from "./settings";

// The generated document is parsed before it is read, so a keyword this test does not expect fails
// here rather than sliding past an assertion that only checks the keys it happens to know.
const Property = v.looseObject({ description: v.string() });

const ProviderObject = v.strictObject({
  type: v.literal("object"),
  additionalProperties: v.literal(false),
  required: v.array(v.string()),
  properties: v.record(v.string(), Property),
});

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
        webPort: v.looseObject({
          type: v.literal("integer"),
          minimum: v.number(),
          maximum: v.number(),
          description: v.string(),
        }),
        authUrl: Property,
        trustedOrigins: Property,
      }),
    }),
    providers: v.strictObject({
      type: v.literal("object"),
      additionalProperties: v.literal(false),
      required: v.array(v.string()),
      properties: v.strictObject({
        kilocode: ProviderObject,
        tokenharbor: ProviderObject,
        yeta: ProviderObject,
        river: ProviderObject,
        nous: ProviderObject,
        hyper: ProviderObject,
        opencode: ProviderObject,
        zro: ProviderObject,
      }),
    }),
    update: v.strictObject({
      type: v.literal("object"),
      additionalProperties: v.literal(false),
      required: v.array(v.string()),
      properties: v.strictObject({
        webUrl: Property,
        apiUrl: Property,
      }),
    }),
  }),
});

const document = v.parse(GeneratedSchema, settingsSchema);

const server = document.properties.server.properties;

const providers = document.properties.providers.properties;

const update = document.properties.update.properties;

describe("the generated schema", () => {
  test("it names the document", () => {
    expect(document.$schema).toContain("json-schema.org");
    expect(document.title).toBe("bandar config.json");
    expect(document.description).toContain("BANDAR_HOME");
  });

  test("it lists the keys the parser reads, and no others", () => {
    expect(Object.keys(document.properties)).toEqual(["$schema", "server", "providers", "update"]);
    expect(Object.keys(server)).toEqual(["host", "port", "webPort", "authUrl", "trustedOrigins"]);
    expect(Object.keys(providers)).toEqual([...BUILT_IN_PROVIDER_KINDS]);
    expect(Object.keys(providers.kilocode.properties)).toEqual(["baseUrl", "catalogUrl"]);
    expect(Object.keys(providers.tokenharbor.properties)).toEqual(["baseUrl"]);
    expect(Object.keys(providers.yeta.properties)).toEqual(["baseUrl"]);
    expect(Object.keys(providers.river.properties)).toEqual(["baseUrl", "catalogUrl"]);
    expect(Object.keys(providers.nous.properties)).toEqual(["baseUrl", "authUrl"]);
    expect(Object.keys(providers.hyper.properties)).toEqual(["baseUrl"]);
    expect(Object.keys(providers.opencode.properties)).toEqual(["baseUrl"]);
    expect(Object.keys(providers.zro.properties)).toEqual(["baseUrl"]);
    expect(Object.keys(update)).toEqual(["webUrl", "apiUrl"]);
  });

  test("every key is optional, as the parser has it", () => {
    expect(document.required).toEqual([]);
    expect(document.properties.server.required).toEqual([]);
    expect(document.properties.providers.required).toEqual([]);
    expect(document.properties.update.required).toEqual([]);

    for (const provider of Object.values(providers)) expect(provider.required).toEqual([]);
  });

  test("the port bounds come from the shared constants", () => {
    expect(server.port.minimum).toBe(MIN_PORT);
    expect(server.port.maximum).toBe(MAX_PORT);
    expect(server.webPort.minimum).toBe(MIN_PORT);
    expect(server.webPort.maximum).toBe(MAX_PORT);
  });

  test("each key carries the help an editor shows", () => {
    const fields = [
      ...Object.values(server),
      ...Object.values(providers).flatMap((provider) => Object.values(provider.properties)),
      ...Object.values(update),
      document.properties.$schema,
    ];

    for (const [index, property] of fields.entries())
      expect(property.description, String(index)).toEqual(expect.any(String));
  });

  test("the port defaults in the help come from the constants", () => {
    expect(server.port.description).toContain(String(DEFAULT_API_PORT));
    expect(server.webPort.description).toContain(String(DEFAULT_WEB_PORT));
  });

  test("the text written beside the settings is the document", () => {
    expect(JSON.parse(SETTINGS_SCHEMA_TEXT)).toEqual(document);
    expect(SETTINGS_SCHEMA_TEXT.endsWith("\n")).toBe(true);
  });
});
