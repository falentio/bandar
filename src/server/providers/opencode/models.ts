import type { Compat } from "../../../shared/providers";
import { NO_PRICE, type ModelPrices } from "../catalog";

/** Why a listed Go model cannot be called through bandar yet. */
export type OpenCodeGap = "undocumented";

export type OpenCodeModel =
  | { readonly id: string; readonly compat: Compat; readonly prices: ModelPrices }
  | { readonly id: string; readonly compat: null; readonly gap: OpenCodeGap };

/**
 * Every id the Go gateway lists, in the docs table's order. Prices are USD per
 * million tokens at the base context tier, and DeepSeek quotes peak.
 */
export const OPENCODE_MODELS: readonly OpenCodeModel[] = [
  { id: "grok-4.7", compat: "responses", prices: NO_PRICE },
  { id: "gpt-6-luna", compat: "responses", prices: NO_PRICE },
  { id: "gpt-5.6-luna", compat: "responses", prices: NO_PRICE },
  {
    id: "claude-haiku-5-5",
    compat: "messages",
    prices: { inputPricePerMtok: 0.1, outputPricePerMtok: 0.5 },
  },
  // The docs quote no price for the one Google model, so it imports unpriced.
  { id: "gemini-4-argon", compat: "genai", prices: NO_PRICE },
  {
    id: "glm-5.3-flash",
    compat: "chat",
    prices: { inputPricePerMtok: 0.15, outputPricePerMtok: 0.5 },
  },
  { id: "glm-5.3", compat: "chat", prices: { inputPricePerMtok: 1.4, outputPricePerMtok: 4.4 } },
  { id: "glm-5.2", compat: "chat", prices: { inputPricePerMtok: 1.4, outputPricePerMtok: 4.4 } },
  {
    id: "kimi-k3.1-pro",
    compat: "chat",
    prices: { inputPricePerMtok: 2, outputPricePerMtok: 10 },
  },
  { id: "kimi-k3", compat: "chat", prices: { inputPricePerMtok: 3, outputPricePerMtok: 15 } },
  {
    id: "kimi-k2.7-code",
    compat: "chat",
    prices: { inputPricePerMtok: 0.95, outputPricePerMtok: 4 },
  },
  {
    id: "longcat-2.0",
    compat: "chat",
    prices: { inputPricePerMtok: 0.3, outputPricePerMtok: 1.2 },
  },
  {
    id: "deepseek-v4.1-flash",
    compat: "chat",
    prices: { inputPricePerMtok: 0.3, outputPricePerMtok: 1.2 },
  },
  {
    id: "deepseek-v4-pro",
    compat: "chat",
    prices: { inputPricePerMtok: 1.32, outputPricePerMtok: 3.96 },
  },
  {
    id: "mimo-v2.6-flash",
    compat: "chat",
    prices: { inputPricePerMtok: 0.14, outputPricePerMtok: 0.28 },
  },
  {
    id: "mimo-v2.6-pro",
    compat: "chat",
    prices: { inputPricePerMtok: 0.435, outputPricePerMtok: 0.87 },
  },
  {
    id: "mimo-v2.5",
    compat: "chat",
    prices: { inputPricePerMtok: 0.14, outputPricePerMtok: 0.28 },
  },
  {
    id: "mimo-v2.5-pro",
    compat: "chat",
    prices: { inputPricePerMtok: 0.435, outputPricePerMtok: 0.87 },
  },
  {
    id: "minimax-m3.1-flash",
    compat: "chat",
    prices: { inputPricePerMtok: 0.15, outputPricePerMtok: 0.6 },
  },
  {
    id: "minimax-m3",
    compat: "messages",
    prices: { inputPricePerMtok: 0.3, outputPricePerMtok: 1.2 },
  },
  { id: "muse-spark-1.3-contributor", compat: "responses", prices: NO_PRICE },
  { id: "muse-spark-1.2-contributor", compat: "responses", prices: NO_PRICE },
  {
    id: "qwen3.8-max",
    compat: "messages",
    prices: { inputPricePerMtok: 2, outputPricePerMtok: 6 },
  },
  {
    id: "qwen3.8-flash",
    compat: "messages",
    prices: { inputPricePerMtok: 0.15, outputPricePerMtok: 0.47 },
  },
  {
    id: "qwen3.7-plus",
    compat: "messages",
    prices: { inputPricePerMtok: 0.4, outputPricePerMtok: 1.6 },
  },
  {
    id: "hy4-preview",
    compat: "chat",
    prices: { inputPricePerMtok: 0.834, outputPricePerMtok: 2.501 },
  },
  { id: "hy3", compat: "chat", prices: { inputPricePerMtok: 0.14, outputPricePerMtok: 0.58 } },
  {
    id: "step-5-preview",
    compat: "chat",
    prices: { inputPricePerMtok: 1, outputPricePerMtok: 2.7 },
  },
  { id: "beam-free", compat: "chat", prices: { inputPricePerMtok: 0, outputPricePerMtok: 0 } },
  {
    id: "iceman-contributor-free",
    compat: "chat",
    prices: { inputPricePerMtok: 0, outputPricePerMtok: 0 },
  },
  { id: "glm-5.1", compat: null, gap: "undocumented" },
  { id: "grok-4.6", compat: null, gap: "undocumented" },
  { id: "kimi-k2.6", compat: null, gap: "undocumented" },
  { id: "minimax-m2.5", compat: null, gap: "undocumented" },
  { id: "minimax-m2.7", compat: null, gap: "undocumented" },
  { id: "omen-alpha", compat: null, gap: "undocumented" },
  { id: "qwen3.6-plus", compat: null, gap: "undocumented" },
  { id: "qwen3.7-max", compat: null, gap: "undocumented" },
];

const BY_ID = new Map(OPENCODE_MODELS.map((model) => [model.id, model] as const));

export function opencodeModelOf(upstreamModel: string): OpenCodeModel | undefined {
  return BY_ID.get(upstreamModel);
}

export function gapMessage(gap: OpenCodeGap, upstreamModel: string): string {
  switch (gap) {
    case "undocumented":
      return `the opencode go docs do not name a wire for ${upstreamModel}`;
  }
}
