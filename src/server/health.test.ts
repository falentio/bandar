import { describe, expect, test } from "vite-plus/test";
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_CAP_MS,
  cooldownMs,
  isCoolingDown,
  subjectFor,
  subjectKey,
  type FailureTarget,
} from "./health";

const target: FailureTarget = {
  providerId: "provider-1",
  modelId: "model-1",
  credentialId: "credential-1",
};

const anonymous: FailureTarget = { ...target, credentialId: null };

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("cooldownMs", () => {
  test("grows the cooldown by a factor per consecutive failure", () => {
    expect(COOLDOWN_BASE_MS).toBe(30_000);
    expect(cooldownMs(1, null, NOW)).toBe(30_000);
    expect(cooldownMs(2, null, NOW)).toBe(60_000);
    expect(cooldownMs(3, null, NOW)).toBe(120_000);
  });

  test("caps the cooldown at one day", () => {
    expect(COOLDOWN_CAP_MS).toBe(86_400_000);
    expect(cooldownMs(13, null, NOW)).toBe(COOLDOWN_CAP_MS);
    expect(cooldownMs(400, null, NOW)).toBe(COOLDOWN_CAP_MS);
  });

  test("waits for the refill a vendor named, past the growth", () => {
    expect(cooldownMs(1, new Date(NOW.getTime() + 6 * 3_600_000), NOW)).toBe(6 * 3_600_000);
  });

  test("keeps the growth when it outlasts the named refill", () => {
    expect(cooldownMs(3, new Date(NOW.getTime() + 1000), NOW)).toBe(120_000);
  });

  test("caps a named refill at one day", () => {
    const later = new Date(NOW.getTime() + 30 * 86_400_000);

    expect(cooldownMs(1, later, NOW)).toBe(COOLDOWN_CAP_MS);
  });

  test("never goes below the growth for a refill already past", () => {
    expect(cooldownMs(2, new Date(NOW.getTime() - 60_000), NOW)).toBe(60_000);
  });
});

describe("isCoolingDown", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  test("reads a flag in the future as cooling down", () => {
    expect(isCoolingDown(new Date(now + 1), now)).toBe(true);
  });

  test("reads a missing or elapsed flag as available", () => {
    expect(isCoolingDown(null, now)).toBe(false);
    expect(isCoolingDown(new Date(now - 1), now)).toBe(false);
    expect(isCoolingDown(new Date(now), now)).toBe(false);
  });
});

describe("subjectFor", () => {
  test("flags the credential for an auth or rate-limit failure", () => {
    expect(subjectFor("auth", target)).toEqual({ kind: "credential", id: "credential-1" });
    expect(subjectFor("rate_limit", target)).toEqual({ kind: "credential", id: "credential-1" });
  });

  test("flags the credential whose allowance ran out", () => {
    expect(subjectFor("budget_exceeded", target)).toEqual({
      kind: "credential",
      id: "credential-1",
    });
  });

  test("flags a keyless provider on a budget so the chain still rests it", () => {
    expect(subjectFor("budget_exceeded", anonymous)).toEqual({
      kind: "provider",
      id: "provider-1",
    });
  });

  test("flags the provider for an unavailable or network failure", () => {
    expect(subjectFor("unavailable", target)).toEqual({ kind: "provider", id: "provider-1" });
    expect(subjectFor("network", target)).toEqual({ kind: "provider", id: "provider-1" });
  });

  test("flags the model for a protocol or not-found failure", () => {
    expect(subjectFor("protocol", target)).toEqual({ kind: "model", id: "model-1" });
    expect(subjectFor("not_found", target)).toEqual({ kind: "model", id: "model-1" });
  });

  test("flags nothing for a final or anonymous failure", () => {
    expect(subjectFor("invalid_request", target)).toBeNull();
    expect(subjectFor("unknown", target)).toBeNull();
    expect(subjectFor("auth", anonymous)).toBeNull();
    expect(subjectFor("rate_limit", anonymous)).toBeNull();
  });
});

describe("subjectKey", () => {
  test("separates subjects of different kinds that share an id", () => {
    expect(subjectKey({ kind: "provider", id: "same" })).toBe("provider:same");
    expect(subjectKey({ kind: "model", id: "same" })).toBe("model:same");
  });
});
