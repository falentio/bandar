export type TokensPerSecondInput = {
  readonly outputTokens: number | null;
  readonly ttftMs: number | null;
  readonly durationMs: number;
};

export function tokensPerSecond(input: TokensPerSecondInput): number | null {
  if (input.outputTokens === null || input.ttftMs === null) return null;

  const generationMs = input.durationMs - input.ttftMs;

  if (generationMs <= 0) return null;

  return round(input.outputTokens / (generationMs / 1000), 3);
}

export type CostInput = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
};

export function costUsd(input: CostInput): number | null {
  if (
    input.inputTokens === null ||
    input.outputTokens === null ||
    input.inputPricePerMtok === null ||
    input.outputPricePerMtok === null
  ) {
    return null;
  }

  return round(
    (input.inputTokens / 1_000_000) * input.inputPricePerMtok +
      (input.outputTokens / 1_000_000) * input.outputPricePerMtok,
    8,
  );
}

export function errorRate(errors: number, requests: number): number {
  return requests === 0 ? 0 : round(errors / requests, 4);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}
