import { describe, expect, test } from "vite-plus/test";
import { yetaPrices } from "./pricing";

describe("yeta pricing", () => {
  test("a model ratio becomes USD per million tokens", () => {
    expect(yetaPrices({ model_name: "large", model_ratio: 1.5, completion_ratio: 4 })).toEqual({
      inputPricePerMtok: 3,
      outputPricePerMtok: 12,
    });
  });

  test("a per-call model carries no per-token price", () => {
    expect(
      yetaPrices({ model_name: "image", model_ratio: 1, completion_ratio: 1, quota_type: 1 }),
    ).toEqual({ inputPricePerMtok: null, outputPricePerMtok: null });
  });

  test("a missing, negative, or non-finite ratio stays unpriced", () => {
    expect(yetaPrices({ model_name: "a" })).toEqual({
      inputPricePerMtok: null,
      outputPricePerMtok: null,
    });
    expect(yetaPrices({ model_name: "b", model_ratio: -1, completion_ratio: 2 })).toEqual({
      inputPricePerMtok: null,
      outputPricePerMtok: null,
    });
    expect(yetaPrices({ model_name: "c", model_ratio: "x", completion_ratio: 2 })).toEqual({
      inputPricePerMtok: null,
      outputPricePerMtok: null,
    });
  });

  test("a broken completion ratio leaves the input price alone", () => {
    expect(yetaPrices({ model_name: "d", model_ratio: 1, completion_ratio: -1 })).toEqual({
      inputPricePerMtok: 2,
      outputPricePerMtok: null,
    });
  });
});
