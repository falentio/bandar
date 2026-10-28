import { describe, expect, test } from "vitest";
import { modelChoices } from "./model-options";

describe("modelChoices", () => {
  test("lists tags first as their own list", () => {
    const choices = modelChoices(
      [{ name: "Alpha", models: [{ alias: "sonnet", upstreamModel: "sonnet" }] }],
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
            { alias: "a-one", upstreamModel: "a-one" },
            { alias: "a-two", upstreamModel: "a-two" },
          ],
        },
        { name: "Beta", models: [{ alias: "b-one", upstreamModel: "b-one" }] },
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
        { name: "Alpha", models: [{ alias: "a-one", upstreamModel: "a-one" }] },
      ],
      [],
    );

    expect(choices.providers).toEqual([
      { label: "Alpha", options: [{ value: "a-one", label: "a-one" }] },
    ]);
  });

  test("drops a value that already appeared", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { alias: "tags/fast", upstreamModel: "alpha-fast" },
            { alias: "sonnet", upstreamModel: "sonnet" },
          ],
        },
        { name: "Beta", models: [{ alias: "sonnet", upstreamModel: "beta-sonnet" }] },
      ],
      [{ ref: "tags/fast" }, { ref: "tags/fast" }],
    );

    expect(choices.tags).toEqual([{ value: "tags/fast", label: "tags/fast" }]);
    expect(choices.providers).toEqual([
      { label: "Alpha", options: [{ value: "sonnet", label: "sonnet" }] },
    ]);
  });

  test("adds the upstream name only when it differs from the alias", () => {
    const choices = modelChoices(
      [
        {
          name: "Alpha",
          models: [
            { alias: "sonnet", upstreamModel: "claude-sonnet-4-6" },
            { alias: "haiku", upstreamModel: "haiku" },
          ],
        },
      ],
      [],
    );

    expect(choices.providers[0]?.options).toEqual([
      { value: "sonnet", label: "sonnet (claude-sonnet-4-6)" },
      { value: "haiku", label: "haiku" },
    ]);
  });

  test("both empty gives empty lists", () => {
    expect(modelChoices([], [])).toEqual({ tags: [], providers: [] });
  });
});
