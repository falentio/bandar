import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
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
    });
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
    });
  });

  test("caps a dimension at fifty values", () => {
    expect(parse(repeated(50)).success).toBe(true);
    expect(parse(repeated(51)).success).toBe(false);
  });
});
