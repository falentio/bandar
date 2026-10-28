import { describe, expect, test } from "vite-plus/test";
import {
  BUILT_IN_PROVIDER_KINDS,
  COMPATIBILITIES,
  PROVIDER_KINDS,
  PROVIDER_KIND_LABELS,
} from "../../shared/providers";
import { TAG_SLUG } from "../../shared/slugs";
import { builtInProviders, compatsOf, definitionFor, reservedProviderSlugs } from "./registry";

const CHAT_ONLY_KINDS = ["kilocode", "tokenharbor", "yeta", "river", "nous", "hyper"] as const;

describe("provider registry", () => {
  test("every kind declares at least one wire, and each wire's adapter is that kind's", () => {
    for (const kind of PROVIDER_KINDS) {
      const { routes } = definitionFor(kind);

      expect(compatsOf(kind).length).toBeGreaterThan(0);

      for (const compat of COMPATIBILITIES) {
        const route = routes[compat];

        if (route === undefined) continue;

        expect(route.adapter.kind).toBe(kind);
      }
    }
  });

  test("a route's mount is an absolute path without a trailing slash", () => {
    for (const kind of PROVIDER_KINDS) {
      const { routes } = definitionFor(kind);

      for (const compat of COMPATIBILITIES) {
        const mount = routes[compat]?.mount;

        if (mount === undefined) continue;

        expect(mount.startsWith("/")).toBe(true);
        expect(mount.endsWith("/")).toBe(false);
      }
    }
  });

  test("a kind's wires are the ones its docs table names", () => {
    expect(compatsOf("openai")).toEqual(["chat", "responses"]);
    expect(compatsOf("anthropic")).toEqual(["messages"]);
    expect(compatsOf("google")).toEqual(["genai"]);
    expect(compatsOf("opencode")).toEqual(["chat", "responses", "messages", "genai"]);

    for (const kind of CHAT_ONLY_KINDS) expect(compatsOf(kind)).toEqual(["chat"]);
  });

  test("every compat is declared by at least one kind", () => {
    const declared = new Set(PROVIDER_KINDS.flatMap((kind) => compatsOf(kind)));

    for (const compat of COMPATIBILITIES) expect(declared.has(compat)).toBe(true);
  });

  test("a default either names a declared route or gives a reason", () => {
    for (const kind of PROVIDER_KINDS) {
      const definition = definitionFor(kind);

      for (const probe of ["", "drift-probe"]) {
        const choice = definition.defaultCompat(probe);

        if (choice.compat === null) {
          expect(choice.reason).not.toBe("");
          continue;
        }

        expect(definition.routes[choice.compat]).toBeDefined();
      }
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

  test("a built-in's label is the name it seeds", () => {
    for (const definition of builtInProviders) {
      expect(PROVIDER_KIND_LABELS[definition.kind]).toBe(definition.builtIn.name);
    }
  });

  test("reserved slugs cover the tag route and every built-in", () => {
    expect(reservedProviderSlugs.has(TAG_SLUG)).toBe(true);

    for (const definition of builtInProviders) {
      expect(reservedProviderSlugs.has(definition.builtIn.slug)).toBe(true);
    }
  });
});
