import { describe, expect, test } from "vite-plus/test";
import { gapMessage, OPENCODE_MODELS, opencodeModelOf, type OpenCodeModel } from "./models";

function count(where: (model: OpenCodeModel) => boolean): number {
  return OPENCODE_MODELS.filter(where).length;
}

describe("opencode go model table", () => {
  test("the table is the gateway's full 38-id list", () => {
    expect(OPENCODE_MODELS.length).toBe(38);
  });

  test("30 rows split across the four compats and 8 carry a gap", () => {
    expect(count((model) => model.compat === "chat")).toBe(19);
    expect(count((model) => model.compat === "responses")).toBe(5);
    expect(count((model) => model.compat === "messages")).toBe(5);
    expect(count((model) => model.compat === "genai")).toBe(1);
    expect(count((model) => model.compat === null && model.gap === "undocumented")).toBe(8);
  });

  test("every responses-only id is callable and unpriced", () => {
    for (const id of [
      "grok-4.7",
      "gpt-6-luna",
      "gpt-5.6-luna",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
    ]) {
      expect(opencodeModelOf(id)).toMatchObject({
        compat: "responses",
        prices: { inputPricePerMtok: null, outputPricePerMtok: null },
      });
    }
  });

  test("every id is unique and resolves back to its own row", () => {
    const ids = OPENCODE_MODELS.map((model) => model.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) expect(opencodeModelOf(id)?.id).toBe(id);

    expect(opencodeModelOf("not-a-go-model")).toBeUndefined();
  });

  test("a sibling suffix does not decide the compat", () => {
    expect(opencodeModelOf("minimax-m3")?.compat).toBe("messages");
    expect(opencodeModelOf("minimax-m3.1-flash")?.compat).toBe("chat");
    expect(opencodeModelOf("qwen3.8-max")?.compat).toBe("messages");
    expect(opencodeModelOf("qwen3.7-max")).toMatchObject({ compat: null, gap: "undocumented" });
  });

  test("a callable row is priced on both sides or on neither", () => {
    for (const model of OPENCODE_MODELS) {
      if (model.compat === null) continue;

      const input = model.prices.inputPricePerMtok;
      const output = model.prices.outputPricePerMtok;

      expect(input === null).toBe(output === null);

      if (input === null || output === null) continue;

      expect(input).toBeGreaterThanOrEqual(0);
      expect(output).toBeGreaterThanOrEqual(0);
    }
  });

  test("an unknown price is null while a free model is zero", () => {
    expect(opencodeModelOf("gemini-4-argon")).toMatchObject({
      prices: { inputPricePerMtok: null, outputPricePerMtok: null },
    });
    expect(opencodeModelOf("beam-free")).toMatchObject({
      prices: { inputPricePerMtok: 0, outputPricePerMtok: 0 },
    });
  });

  test("a gap message names the model and the reason", () => {
    const undocumented = gapMessage("undocumented", "omen-alpha");

    expect(undocumented).toContain("omen-alpha");
    expect(undocumented).toContain("docs do not name a wire");
  });
});
