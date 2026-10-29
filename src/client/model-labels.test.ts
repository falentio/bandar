import { describe, expect, test } from "vite-plus/test";
import { modelSecondaryOf } from "./model-labels";

describe("modelSecondaryOf", () => {
  test("shows a custom address beside a different label", () => {
    expect(
      modelSecondaryOf({
        slug: "fast-cheap",
        ref: "local-openai/gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        alias: "Fast and cheap",
      }),
    ).toBe("fast-cheap");
  });

  test("shows the upstream id under a label that is not its address", () => {
    expect(
      modelSecondaryOf({
        slug: "local-openai/gpt-4o-mini",
        ref: "local-openai/gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        alias: "Cheap",
      }),
    ).toBe("gpt-4o-mini");
  });

  test("shows nothing beside a label that is its own address", () => {
    expect(
      modelSecondaryOf({
        slug: "fast-cheap",
        ref: "local-openai/gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        alias: "fast-cheap",
      }),
    ).toBeNull();
  });

  test("shows nothing beside a label that is its own upstream id", () => {
    expect(
      modelSecondaryOf({
        slug: "local-openai/gpt-4o-mini",
        ref: "local-openai/gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        alias: null,
      }),
    ).toBeNull();
  });
});
