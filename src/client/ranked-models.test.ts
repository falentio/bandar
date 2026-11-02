import { describe, expect, test } from "vitest";
import type { Tag } from "../shared/tags";
import {
  appendModel,
  availableGroups,
  modelIdsOf,
  moveModelTo,
  rankedModels,
  removeModel,
} from "./ranked-models";

type TagModel = Tag["models"][number];

const sonnet = { modelId: "pm-sonnet", label: "Sonnet", provider: "Alpha" };
const haiku = { modelId: "pm-haiku", label: "Haiku", provider: "Alpha" };
const opus = { modelId: "pm-opus", label: "Opus", provider: "Beta" };
const chain = [sonnet, haiku];

function tagModel(
  modelId: string,
  slug: string,
  alias: string | null,
  upstreamModel: string,
): TagModel {
  return {
    modelId,
    slug,
    alias,
    upstreamModel,
    ref: `alpha/${upstreamModel}`,
    providerId: "provider-alpha",
    providerName: "Alpha",
    providerSlug: "alpha",
    priority: 1,
  };
}

describe("rankedModels", () => {
  test("takes the order from the wire rows, not from priority", () => {
    expect(
      rankedModels([
        tagModel("pm-sonnet", "claude-sonnet", "Sonnet", "claude-sonnet-4-6"),
        tagModel("pm-haiku", "haiku", null, "haiku"),
      ]),
    ).toEqual([
      { modelId: "pm-sonnet", label: "Sonnet", provider: "Alpha" },
      { modelId: "pm-haiku", label: "haiku", provider: "Alpha" },
    ]);
  });

  test("an empty tag gives an empty chain", () => {
    expect(rankedModels([])).toEqual([]);
  });
});

describe("modelIdsOf", () => {
  test("keeps the chain order", () => {
    expect(modelIdsOf([haiku, sonnet])).toEqual(["pm-haiku", "pm-sonnet"]);
  });
});

describe("appendModel", () => {
  test("adds at the tail", () => {
    expect(appendModel(chain, opus)).toEqual([sonnet, haiku, opus]);
  });

  test("returns the same array when the model is already picked", () => {
    expect(appendModel(chain, sonnet)).toBe(chain);
  });
});

describe("removeModel", () => {
  const three = [sonnet, haiku, opus];

  test("removes the head, a middle row, and the tail", () => {
    expect(removeModel(three, "pm-sonnet")).toEqual([haiku, opus]);
    expect(removeModel(three, "pm-haiku")).toEqual([sonnet, opus]);
    expect(removeModel(three, "pm-opus")).toEqual([sonnet, haiku]);
  });

  test("the floor of one returns the same array", () => {
    const only = [sonnet];

    expect(removeModel(only, "pm-sonnet")).toBe(only);
  });

  test("an absent id returns the same array", () => {
    expect(removeModel(chain, "pm-opus")).toBe(chain);
  });
});

describe("moveModelTo", () => {
  const three = [sonnet, haiku, opus];

  test("moves to the head and to the tail", () => {
    expect(modelIdsOf(moveModelTo(three, "pm-opus", 0))).toEqual([
      "pm-opus",
      "pm-sonnet",
      "pm-haiku",
    ]);
    expect(modelIdsOf(moveModelTo(three, "pm-sonnet", 2))).toEqual([
      "pm-haiku",
      "pm-opus",
      "pm-sonnet",
    ]);
  });

  test("clamps a destination past either end", () => {
    expect(modelIdsOf(moveModelTo(three, "pm-sonnet", 9))).toEqual([
      "pm-haiku",
      "pm-opus",
      "pm-sonnet",
    ]);
    expect(modelIdsOf(moveModelTo(three, "pm-opus", -3))).toEqual([
      "pm-opus",
      "pm-sonnet",
      "pm-haiku",
    ]);
  });

  test("returns the same array for the current position and an absent id", () => {
    expect(moveModelTo(three, "pm-haiku", 1)).toBe(three);
    expect(moveModelTo(three, "pm-missing", 0)).toBe(three);
  });
});

describe("availableGroups", () => {
  const catalog = [
    {
      label: "Alpha",
      options: [
        { value: "pm-sonnet", label: "Sonnet" },
        { value: "pm-haiku", label: "Haiku" },
      ],
    },
    {
      label: "Beta",
      options: [
        { value: "pm-opus", label: "Opus" },
        { value: "pm-flash", label: "Flash" },
      ],
    },
    { label: "Empty", options: [] },
  ];

  test("drops the picked rows and keeps the rest in order", () => {
    expect(availableGroups(catalog, [haiku])).toEqual([
      { label: "Alpha", options: [{ value: "pm-sonnet", label: "Sonnet" }] },
      {
        label: "Beta",
        options: [
          { value: "pm-opus", label: "Opus" },
          { value: "pm-flash", label: "Flash" },
        ],
      },
    ]);
  });

  test("drops a provider emptied by the filter", () => {
    expect(
      availableGroups(catalog, [sonnet, haiku, opus, { ...opus, modelId: "pm-flash" }]),
    ).toEqual([]);
  });

  test("an empty chain keeps the catalog, minus its empty providers", () => {
    expect(availableGroups(catalog, [])).toEqual(catalog.slice(0, 2));
  });
});
