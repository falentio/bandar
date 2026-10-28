import { describe, expect, test } from "vite-plus/test";
import { opencodeEntries } from "./catalog";
import { OPENCODE_MODELS } from "./models";

describe("opencode go catalog", () => {
  test("imports only the listed ids the table can serve, in table order", () => {
    const entries = opencodeEntries([
      "hyper-prism",
      "omen-alpha",
      "gpt-6-luna",
      "minimax-m3",
      "glm-5.3",
      "gemini-4-argon",
      "claude-haiku-5-5",
    ]);

    expect(entries.map((entry) => entry.upstreamModel)).toEqual([
      "gpt-6-luna",
      "claude-haiku-5-5",
      "gemini-4-argon",
      "glm-5.3",
      "minimax-m3",
    ]);
  });

  test("a listed id carries the table's price, and an unknown price stays null", () => {
    expect(opencodeEntries(["glm-5.3", "gemini-4-argon", "beam-free"])).toEqual([
      {
        upstreamModel: "gemini-4-argon",
        alias: "gemini-4-argon",
        inputPricePerMtok: null,
        outputPricePerMtok: null,
      },
      {
        upstreamModel: "glm-5.3",
        alias: "glm-5.3",
        inputPricePerMtok: 1.4,
        outputPricePerMtok: 4.4,
      },
      {
        upstreamModel: "beam-free",
        alias: "beam-free",
        inputPricePerMtok: 0,
        outputPricePerMtok: 0,
      },
    ]);
  });

  test("a repeated id imports once", () => {
    expect(opencodeEntries(["glm-5.3", "glm-5.3"]).length).toBe(1);
  });

  test("a gapped or unknown id never imports, even when the gateway lists it", () => {
    expect(opencodeEntries(["omen-alpha", "glm-5.1", "not-a-go-model"])).toEqual([]);
  });
});

describe("opencode go catalog against the full gateway list", () => {
  test("the 38 listed ids import as the 30 servable rows", () => {
    const listed = OPENCODE_MODELS.map((model) => model.id);
    const entries = opencodeEntries(listed);

    expect(entries).toHaveLength(30);
    expect(new Set(entries.map((entry) => entry.upstreamModel))).toEqual(
      new Set(OPENCODE_MODELS.filter((model) => model.compat !== null).map((model) => model.id)),
    );
  });
});
