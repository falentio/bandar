import { BUILT_IN_PROVIDER_KINDS } from "../../shared/providers";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_PROVIDER_ENDPOINTS,
  PROVIDER_MOUNTS,
  authUrlFor,
  endpointSpecsFor,
  providerEndpoint,
  withMount,
} from "./endpoints";

describe("provider endpoints", () => {
  test("every built-in kind has a default endpoint", () => {
    expect(Object.keys(DEFAULT_PROVIDER_ENDPOINTS)).toEqual([...BUILT_IN_PROVIDER_KINDS]);
  });

  test("the defaults carry the full base URL and the catalog or login each kind uses", () => {
    expect(DEFAULT_PROVIDER_ENDPOINTS).toEqual({
      kilocode: {
        baseUrl: "https://api.kilo.ai/api/openrouter",
        catalogUrl: "https://api.kilo.ai/api/gateway/models",
        authUrl: "https://api.kilo.ai",
      },
      tokenharbor: {
        baseUrl: "https://tokenharbor.ai/v1",
        catalogUrl: null,
        authUrl: null,
      },
      yeta: { baseUrl: "https://platform.yeta.ai/v1", catalogUrl: null, authUrl: null },
      river: {
        baseUrl: "https://api.river.ai/v1",
        catalogUrl: "https://console.river.ai/api/public/pricing",
        authUrl: null,
      },
      nous: {
        baseUrl: "https://inference-api.nousresearch.com/v1",
        catalogUrl: null,
        authUrl: "https://portal.nousresearch.com",
      },
      hyper: { baseUrl: "https://hyper.charm.land/v1", catalogUrl: null, authUrl: null },
      opencode: { baseUrl: "https://opencode.ai/inference", catalogUrl: null, authUrl: null },
      zro: { baseUrl: "https://zro.moonmath.ai/v1", catalogUrl: null, authUrl: null },
    });
  });

  test("only kilocode and river declare a catalog URL", () => {
    for (const kind of BUILT_IN_PROVIDER_KINDS) {
      const specs = endpointSpecsFor(kind);

      expect(specs.catalogUrl !== undefined, kind).toBe(kind === "kilocode" || kind === "river");
      expect(specs.authUrl !== undefined, kind).toBe(kind === "nous");
    }
  });

  test("each field names the variable the environment sets it with", () => {
    expect(endpointSpecsFor("kilocode").baseUrl.env).toBe("BANDAR_KILOCODE_API");
    expect(endpointSpecsFor("kilocode").catalogUrl?.env).toBe("BANDAR_KILOCODE_MODELS_URL");
    expect(endpointSpecsFor("tokenharbor").baseUrl.env).toBe("BANDAR_TOKENHARBOR_API");
    expect(endpointSpecsFor("yeta").baseUrl.env).toBe("BANDAR_YETA_API");
    expect(endpointSpecsFor("river").baseUrl.env).toBe("BANDAR_RIVER_API");
    expect(endpointSpecsFor("river").catalogUrl?.env).toBe("BANDAR_RIVER_PRICING_URL");
    expect(endpointSpecsFor("nous").baseUrl.env).toBe("BANDAR_NOUS_API");
    expect(endpointSpecsFor("nous").authUrl?.env).toBe("BANDAR_NOUS_PORTAL");
    expect(endpointSpecsFor("hyper").baseUrl.env).toBe("BANDAR_HYPER_API");
    expect(endpointSpecsFor("opencode").baseUrl.env).toBe("BANDAR_OPENCODE_API");
    expect(endpointSpecsFor("zro").baseUrl.env).toBe("BANDAR_ZRO_API");
  });

  test("the mounts are the path each kind appends to an origin", () => {
    expect(PROVIDER_MOUNTS).toEqual({
      kilocode: "/api/openrouter",
      tokenharbor: "/v1",
      yeta: "/v1",
      river: "/v1",
      nous: "/v1",
      hyper: "/v1",
      opencode: "/inference",
      zro: "/v1",
    });
  });

  test("an environment origin gains the mount, with trailing slashes removed", () => {
    expect(withMount("kilocode", "http://127.0.0.1:9/kilo")).toBe(
      "http://127.0.0.1:9/kilo/api/openrouter",
    );
    expect(withMount("tokenharbor", "http://127.0.0.1:9/harbor/")).toBe(
      "http://127.0.0.1:9/harbor/v1",
    );
    expect(withMount("opencode", "http://127.0.0.1:9/opencode")).toBe(
      "http://127.0.0.1:9/opencode/inference",
    );
  });

  test("kilocode strips its mount for the login origin, and falls back to the URL origin", () => {
    expect(authUrlFor("https://kilo.example.test/api/openrouter", "/api/openrouter")).toBe(
      "https://kilo.example.test",
    );
    expect(authUrlFor("https://kilo.example.test/gateway", "/api/openrouter")).toBe(
      "https://kilo.example.test",
    );
  });

  test("only kilocode derives a login origin from its base URL", () => {
    expect(
      providerEndpoint("kilocode", "https://kilo.example.test/api/openrouter", null, null).authUrl,
    ).toBe("https://kilo.example.test");
    expect(
      providerEndpoint("nous", "https://nous.example.test/v1", null, "https://portal.example.test")
        .authUrl,
    ).toBe("https://portal.example.test");
    expect(
      providerEndpoint("hyper", "https://hyper.example.test/v1", null, null).authUrl,
    ).toBeNull();
  });
});
