import { describe, expect, test } from "vite-plus/test";
import { parseCredential } from "./credential";

describe("credential bundles", () => {
  test("an oauth bundle sealed before renewal fields still parses", () => {
    const parsed = parseCredential(
      JSON.stringify({
        authMode: "oauth",
        accessToken: "kilo-device-token",
        organizationId: "org-1",
      }),
    );

    expect(parsed).toEqual({
      authMode: "oauth",
      accessToken: "kilo-device-token",
      organizationId: "org-1",
      refreshToken: null,
      expiresAt: null,
    });
  });

  test("an oauth bundle keeps its refresh token and expiry", () => {
    expect(
      parseCredential(
        JSON.stringify({
          authMode: "oauth",
          accessToken: "nous-access-1",
          organizationId: null,
          refreshToken: "rt-1",
          expiresAt: 1_700_000_000_000,
        }),
      ),
    ).toEqual({
      authMode: "oauth",
      accessToken: "nous-access-1",
      organizationId: null,
      refreshToken: "rt-1",
      expiresAt: 1_700_000_000_000,
    });
  });

  test("an api-key bundle is the bare shape", () => {
    expect(parseCredential(JSON.stringify({ authMode: "api-key", apiKey: "sk-1" }))).toEqual({
      authMode: "api-key",
      apiKey: "sk-1",
    });
  });
});
