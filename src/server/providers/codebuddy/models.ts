import type { ProviderCatalog } from "../types";

type ManifestModel = {
  readonly id: string;
  readonly name: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
};

// Ids, names, and limits come from the CLI's product.json at 2.179.2; CodeBuddy bills credits, not USD.
const MANIFEST: readonly ManifestModel[] = [
  { id: "default-model", name: "Auto", maxInputTokens: 176_000, maxOutputTokens: 24_000 },
  { id: "fast-model", name: "Fast", maxInputTokens: 200_000, maxOutputTokens: 32_000 },
  { id: "balanced-model", name: "Balanced", maxInputTokens: 256_000, maxOutputTokens: 32_000 },
  { id: "primary-model", name: "Primary", maxInputTokens: 272_000, maxOutputTokens: 72_000 },
  { id: "deep-model", name: "Deep", maxInputTokens: 176_000, maxOutputTokens: 24_000 },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    id: "deepseek-v4.1-flash-sg",
    name: "DeepSeek V4.1 Flash SG",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  { id: "gpt-6-astra", name: "GPT-6 Astra", maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  { id: "hy4-preview", name: "HY4 Preview", maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
  { id: "hy3", name: "HY3", maxInputTokens: 192_000, maxOutputTokens: 64_000 },
  {
    id: "kimi-k2.8-preview",
    name: "Kimi K2.8 Preview",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  { id: "gpt-5.5", name: "GPT-5.5", maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  { id: "gpt-5.4", name: "GPT-5.4", maxInputTokens: 272_000, maxOutputTokens: 72_000 },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },
  { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1_000_000, maxOutputTokens: 48_000 },
  { id: "glm-5.2", name: "GLM-5.2", maxInputTokens: 1_000_000, maxOutputTokens: 48_000 },
  { id: "kimi-k3", name: "Kimi K3", maxInputTokens: 1_000_000, maxOutputTokens: 32_000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", maxInputTokens: 256_000, maxOutputTokens: 32_000 },
];

export const fetchCodebuddyCatalog: ProviderCatalog = async () =>
  MANIFEST.map((model) => ({
    upstreamModel: model.id,
    label: model.name,
    inputPricePerMtok: null,
    cacheInputPricePerMtok: null,
    outputPricePerMtok: null,
    contextWindow: model.maxInputTokens,
    maxOutput: model.maxOutputTokens,
    inputModalities: ["text", "image"],
  }));
