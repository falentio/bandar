import { describe, expect, test } from "vite-plus/test";
import { gapMessage, OPENCODE_MODELS, opencodeModelOf, type OpenCodeModel } from "./models";

function count(where: (model: OpenCodeModel) => boolean): number {
  return OPENCODE_MODELS.filter(where).length;
}

describe("opencode go model table", () => {
  test("the table is the gateway's full 38-id list", () => {
    expect(OPENCODE_MODELS.length).toBe(38);
  });

  test("25 rows split across the three wires and 13 carry a gap", () => {
    expect(count((model) => model.wire === "openai")).toBe(19);
    expect(count((model) => model.wire === "anthropic")).toBe(5);
    expect(count((model) => model.wire === "google")).toBe(1);
    expect(count((model) => model.wire === null && model.gap === "responses")).toBe(5);
    expect(count((model) => model.wire === null && model.gap === "undocumented")).toBe(8);
  });

  test("every id is unique and resolves back to its own row", () => {
    const ids = OPENCODE_MODELS.map((model) => model.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) expect(opencodeModelOf(id)?.id).toBe(id);

    expect(opencodeModelOf("not-a-go-model")).toBeUndefined();
  });

  test("a sibling suffix does not decide the wire", () => {
    expect(opencodeModelOf("minimax-m3")?.wire).toBe("anthropic");
    expect(opencodeModelOf("minimax-m3.1-flash")?.wire).toBe("openai");
    expect(opencodeModelOf("qwen3.8-max")?.wire).toBe("anthropic");
    expect(opencodeModelOf("qwen3.7-max")).toMatchObject({ wire: null, gap: "undocumented" });
  });

  test("a callable row is priced on both sides or on neither", () => {
    for (const model of OPENCODE_MODELS) {
      if (model.wire === null) continue;

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
    const responses = gapMessage("responses", "gpt-6-luna");
    const undocumented = gapMessage("undocumented", "omen-alpha");

    expect(responses).toContain("gpt-6-luna");
    expect(responses).toContain("responses");
    expect(undocumented).toContain("omen-alpha");
    expect(undocumented).not.toContain("responses");
  });
});
