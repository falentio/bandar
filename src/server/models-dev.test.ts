import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import {
  ModelsDevPayloadSchema,
  parseModelLimits,
  pickModelLimit,
  type ProviderLimit,
} from "./models-dev";

const PAYLOAD = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-5": { limit: { context: 200000, output: 64000 } },
    },
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    models: {
      "claude-sonnet-4-5": { limit: { context: 1000000, output: 64000 } },
      "gpt-5.1": { limit: { context: 400000 } },
      "free-model": {},
    },
  },
};

const SONNET = "claude-sonnet-4-5";

function entriesOf(modelId: string): readonly ProviderLimit[] {
  return parseModelLimits(PAYLOAD).get(modelId) ?? [];
}

describe("parseModelLimits", () => {
  test("keeps one entry per provider", () => {
    expect(entriesOf(SONNET).map((entry) => entry.providerId)).toEqual(["anthropic", "opencode"]);
  });

  test("keeps a context window with no output beside it", () => {
    expect(entriesOf("gpt-5.1")).toEqual([
      { providerId: "opencode", providerName: "opencode", contextWindow: 400000, maxOutput: null },
    ]);
  });

  test("drops a model that reports no limit", () => {
    expect(parseModelLimits(PAYLOAD).has("free-model")).toBe(false);
  });

  test("rejects anything that is not the models.dev shape", () => {
    expect(v.safeParse(ModelsDevPayloadSchema, { anthropic: "nope" }).success).toBe(false);
    expect(v.safeParse(ModelsDevPayloadSchema, null).success).toBe(false);
  });
});

describe("pickModelLimit", () => {
  test("takes the provider that matches the hint", () => {
    expect(pickModelLimit(entriesOf(SONNET), "opencode")?.contextWindow).toBe(1000000);
  });

  test("sizes down when no provider matches", () => {
    expect(pickModelLimit(entriesOf(SONNET), "kilo-code")).toEqual({
      providerId: "anthropic",
      providerName: "Anthropic",
      contextWindow: 200000,
      maxOutput: 64000,
    });
  });

  test("breaks a context tie on the smaller output", () => {
    const entries: readonly ProviderLimit[] = [
      { providerId: "a", providerName: "A", contextWindow: 200000, maxOutput: 128000 },
      { providerId: "b", providerName: "B", contextWindow: 200000, maxOutput: 64000 },
    ];

    expect(pickModelLimit(entries, undefined)?.providerId).toBe("b");
  });

  test("returns null when nothing was found", () => {
    expect(pickModelLimit([], undefined)).toBeNull();
  });
});
