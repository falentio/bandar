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

  test("reserved slugs cover the tag route and every built-in", () => {
    expect(reservedProviderSlugs.has(TAG_SLUG)).toBe(true);

    for (const definition of builtInProviders) {
      expect(reservedProviderSlugs.has(definition.builtIn.slug)).toBe(true);
    }
  });
});
