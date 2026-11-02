import { describe, expect, test } from "vitest";
import { matchesQuery, modelChoices, optionId, step, visibleGroups } from "./model-options";

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

describe("optionId", () => {
  test("keeps two values apart when they differ only in punctuation", () => {
    expect(optionId("box", "tags/fast")).not.toBe(optionId("box", "tags-fast"));
    expect(optionId("box", "a/b")).not.toBe(optionId("box", "a.b"));
  });

  test("prefixes the combobox id", () => {
    expect(optionId("box", "sonnet")).toBe(`box-${encodeURIComponent("sonnet")}`);
  });
});

describe("step", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];

  test("wraps down from the first and up from the last", () => {
    expect(step(options, "a", -1)).toBe("b");
    expect(step(options, "b", 1)).toBe("a");
  });

  test("starts at the first option when nothing is highlighted", () => {
    expect(step(options, null, 1)).toBe("a");
  });

  test("has no answer for an empty list", () => {
    expect(step([], "a", 1)).toBeNull();
  });
});

describe("visibleGroups", () => {
  const groups = [
    {
      label: "Alpha",
      options: [
        { value: "sonnet", label: "Sonnet" },
        { value: "haiku", label: "Haiku" },
      ],
    },
    { label: "Beta", options: [{ value: "flash", label: "Flash" }] },
  ];

  test("matches the label and the value, ignoring case", () => {
    expect(visibleGroups(groups, "SON")).toEqual([
      { label: "Alpha", options: [{ value: "sonnet", label: "Sonnet" }] },
    ]);
    expect(visibleGroups(groups, "flash")).toEqual([
      { label: "Beta", options: [{ value: "flash", label: "Flash" }] },
    ]);
  });

  test("drops a group with no match and keeps the order of the rest", () => {
    expect(visibleGroups(groups, "a")).toEqual([
      { label: "Alpha", options: [{ value: "haiku", label: "Haiku" }] },
      { label: "Beta", options: [{ value: "flash", label: "Flash" }] },
    ]);
  });

  test("a blank query keeps every group", () => {
    expect(visibleGroups(groups, "  ")).toEqual(groups);
  });
});

describe("matchesQuery", () => {
  const option = { value: "openai/sonnet", label: "Sonnet" };

  test("matches on either field", () => {
    expect(matchesQuery(option, "sonnet")).toBe(true);
    expect(matchesQuery(option, "openai")).toBe(true);
    expect(matchesQuery(option, "opus")).toBe(false);
  });

  test("matches everything on an empty needle", () => {
    expect(matchesQuery(option, "")).toBe(true);
  });
});
