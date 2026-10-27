import { describe, expect, test } from "vite-plus/test";
import { BUILT_IN_PROVIDER_KINDS, PROVIDER_KINDS } from "../../shared/providers";
import { TAG_SLUG } from "../../shared/slugs";
import { builtInProviders, definitionFor, reservedProviderSlugs } from "./registry";

describe("provider registry", () => {
  test("every kind resolves to its own adapter", () => {
    for (const kind of PROVIDER_KINDS) {
      expect(definitionFor(kind).adapter.kind).toBe(kind);
    }
  });

  test("built-ins follow the shared kind order", () => {
    expect(builtInProviders.map((definition) => definition.kind)).toEqual([
      ...BUILT_IN_PROVIDER_KINDS,
    ]);
  });

  test("a kind declares every credential mode it can accept", () => {
    for (const kind of PROVIDER_KINDS) {
      const definition = definitionFor(kind);

      expect(new Set(definition.authModes).size).toBe(definition.authModes.length);
      expect(definition.authModes.length).toBeGreaterThan(0);
      expect(definition.authModes.includes("oauth")).toBe(definition.oauth !== undefined);
    }
  });

  test("built-in names and slugs are distinct", () => {
    const names = builtInProviders.map((definition) => definition.builtIn.name);
    const slugs = builtInProviders.map((definition) => definition.builtIn.slug);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("reserved slugs cover the tag route and every built-in", () => {
    expect(reservedProviderSlugs.has(TAG_SLUG)).toBe(true);

    for (const definition of builtInProviders) {
      expect(reservedProviderSlugs.has(definition.builtIn.slug)).toBe(true);
    }
  });
});
