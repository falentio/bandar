import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  MAX_MODEL_REF_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_UPSTREAM_MODEL_LENGTH,
  defaultModelSlug,
} from "../shared/slugs";
import { AnalyticsFiltersInputSchema, filterParams } from "./analytics-filters";

function parse(search: string) {
  return v.safeParse(AnalyticsFiltersInputSchema, filterParams(new URLSearchParams(search)));
}

function repeated(count: number): string {
  return Array.from({ length: count }, () => "providerKind=openai").join("&");
}

describe("filterParams", () => {
  test("collapses repeated parameters into one dimension", () => {
    const params = filterParams(new URLSearchParams("providerKind=openai&providerKind=google"));

    expect(params).toEqual({
      providerKind: ["openai", "google"],
      providerId: [],
      model: [],
      tag: [],
      projectUrl: [],
    });
  });

  test("collects repeated project url values as sent", () => {
    const params = filterParams(
      new URLSearchParams(
        "projectUrl=https%3A%2F%2Facme.test%2Fapp&projectUrl=https%3A%2F%2Facme.test%2Fother",
      ),
    );

    expect(params.projectUrl).toEqual(["https://acme.test/app", "https://acme.test/other"]);
  });

  test("keeps a value repeated across dimensions separate", () => {
    const params = filterParams(new URLSearchParams("model=fast&tag=fast"));

    expect(params.model).toEqual(["fast"]);
    expect(params.tag).toEqual(["fast"]);
  });
});

describe("AnalyticsFiltersInputSchema", () => {
  test("rejects a provider kind outside the vocabulary", () => {
    expect(parse("providerKind=OTA").success).toBe(false);
  });

  test("rejects a tag that is not a slug", () => {
    expect(parse("tag=Not A Tag").success).toBe(false);
  });

  test("accepts a project url a human typed and rejects anything else", () => {
    expect(parse("projectUrl=https%3A%2F%2FExample.com%2Fapp%2F").success).toBe(true);
    expect(parse("projectUrl=not-a-url").success).toBe(false);
    expect(parse("projectUrl=ftp%3A%2F%2Fx%2F").success).toBe(false);
  });

  test("accepts every dimension together", () => {
    const filters = v.parse(
      AnalyticsFiltersInputSchema,
      filterParams(
        new URLSearchParams("providerKind=openai&providerId=provider-1&model=fast&tag=failover"),
      ),
    );

    expect(filters).toEqual({
      providerKind: ["openai"],
      providerId: ["provider-1"],
      model: ["fast"],
      tag: ["failover"],
      projectUrl: [],
    });
  });

  test("caps a dimension at fifty values", () => {
    expect(parse(repeated(50)).success).toBe(true);
    expect(parse(repeated(51)).success).toBe(false);
  });

  test("accepts the longest model address and refuses one character more", () => {
    const providerSlug = "p".repeat(MAX_SLUG_LENGTH);
    const address = defaultModelSlug(providerSlug, "m".repeat(MAX_UPSTREAM_MODEL_LENGTH));

    expect(address).toHaveLength(MAX_MODEL_REF_LENGTH);
    expect(parse("model=" + address).success).toBe(true);
    expect(
      parse("model=" + defaultModelSlug(providerSlug, "m".repeat(MAX_UPSTREAM_MODEL_LENGTH + 1)))
        .success,
    ).toBe(false);
  });
});
