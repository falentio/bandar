import { describe, expect, test } from "vitest";
import { modelChoices } from "./model-options";

describe("modelChoices", () => {
  test("lists tags first as their own list", () => {
    const choices = modelChoices(
      [{ name: "Alpha", models: [{ slug: "sonnet", alias: null, upstreamModel: "sonnet" }] }],
      [{ ref: "tags/coding" }],
    );

    expect(choices.tags).toEqual([{ value: "tags/coding", label: "tags/coding" }]);
    expect(choices.providers).toEqual([
      { label: "Alpha", options: [{ value: "sonnet", label: "sonnet" }] },
    ]);
  });

  test("keeps the given provider and model order", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { slug: "a-one", alias: null, upstreamModel: "a-one" },
            { slug: "a-two", alias: null, upstreamModel: "a-two" },
          ],
        },
        { name: "Beta", models: [{ slug: "b-one", alias: null, upstreamModel: "b-one" }] },
      ],
      [],
    );

    expect(choices.providers.map((group) => group.label)).toEqual(["Alpha", "Beta"]);
    expect(choices.providers.map((group) => group.options.map((option) => option.value))).toEqual([
      ["a-one", "a-two"],
      ["b-one"],
    ]);
  });

  test("drops a provider with no models", () => {
    const choices = modelChoices(
      [
        { name: "Empty", models: [] },
        { name: "Alpha", models: [{ slug: "a-one", alias: null, upstreamModel: "a-one" }] },
      ],
      [],
    );

    expect(choices.providers).toEqual([
      { label: "Alpha", options: [{ value: "a-one", label: "a-one" }] },
    ]);
  });

  test("drops an address that already appeared", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { slug: "same", alias: "Alpha model", upstreamModel: "alpha-one" },
            { slug: "sonnet", alias: null, upstreamModel: "sonnet" },
          ],
        },
        { name: "Beta", models: [{ slug: "same", alias: null, upstreamModel: "beta-one" }] },
      ],
      [{ ref: "tags/fast" }, { ref: "tags/fast" }],
    );

    expect(choices.tags).toEqual([{ value: "tags/fast", label: "tags/fast" }]);
    expect(choices.providers).toEqual([
      {
        label: "Alpha",
        options: [
          { value: "same", label: "Alpha model (same)" },
          { value: "sonnet", label: "sonnet" },
        ],
      },
    ]);
  });

  test("keeps two models that share a label", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { slug: "alpha/gpt-4o-mini", alias: "Cheap", upstreamModel: "gpt-4o-mini" },
            { slug: "beta/gpt-4o-mini", alias: "Cheap", upstreamModel: "gpt-4o-mini" },
          ],
        },
      ],
      [],
    );

    expect(choices.providers[0]?.options).toEqual([
      { value: "alpha/gpt-4o-mini", label: "Cheap (alpha/gpt-4o-mini)" },
      { value: "beta/gpt-4o-mini", label: "Cheap (beta/gpt-4o-mini)" },
    ]);
  });

  test("adds the address only when it differs from the label", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { slug: "openai/sonnet", alias: "Sonnet", upstreamModel: "claude-sonnet-4-6" },
            { slug: "haiku", alias: null, upstreamModel: "haiku" },
          ],
        },
      ],
      [],
    );

    expect(choices.providers[0]?.options).toEqual([
      { value: "openai/sonnet", label: "Sonnet (openai/sonnet)" },
      { value: "haiku", label: "haiku" },
    ]);
  });

  test("both empty gives empty lists", () => {
    expect(modelChoices([], [])).toEqual({ tags: [], providers: [] });
  });
});
