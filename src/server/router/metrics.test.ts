import { describe, expect, test } from "vite-plus/test";
import { costUsd, errorRate, tokensPerSecond } from "./metrics";

describe("tokensPerSecond", () => {
  test("divides output tokens by the generation window after TTFT", () => {
    expect(tokensPerSecond({ outputTokens: 100, ttftMs: 500, durationMs: 2500 })).toBe(50);
  });

  test("rounds to three decimals", () => {
    expect(tokensPerSecond({ outputTokens: 10, ttftMs: 100, durationMs: 400 })).toBe(33.333);
  });

  test("is null without an observable first token", () => {
    expect(tokensPerSecond({ outputTokens: 100, ttftMs: null, durationMs: 2500 })).toBeNull();
  });

  test("is null when usage is missing", () => {
    expect(tokensPerSecond({ outputTokens: null, ttftMs: 100, durationMs: 400 })).toBeNull();
  });

  test("is null when TTFT is not before the end", () => {
    expect(tokensPerSecond({ outputTokens: 100, ttftMs: 400, durationMs: 400 })).toBeNull();
    expect(tokensPerSecond({ outputTokens: 100, ttftMs: 500, durationMs: 400 })).toBeNull();
  });
});

describe("costUsd", () => {
  test("prices input and output per million tokens", () => {
    expect(
      costUsd({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        inputPricePerMtok: 3,
        outputPricePerMtok: 15,
      }),
    ).toBe(10.5);
  });

  test("is null when a price or token count is missing", () => {
    expect(
      costUsd({
        inputTokens: 10,
        outputTokens: 20,
        inputPricePerMtok: null,
        outputPricePerMtok: 15,
      }),
    ).toBeNull();
  });
});

describe("errorRate", () => {
  test("is zero with no requests", () => {
    expect(errorRate(0, 0)).toBe(0);
  });

  test("reports a fraction", () => {
    expect(errorRate(3, 12)).toBe(0.25);
  });
});
