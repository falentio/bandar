import type { ProviderCatalog } from "../types";

type ManifestModel = {
  readonly id: string;
  readonly name: string;
  readonly maxOutputTokens: number;
};

const MAX_INPUT_TOKENS = 176_000;

// Ids, names, and limits come from the CLI's product.json at 2.179.2; CodeBuddy bills credits, not USD.
const MANIFEST: readonly ManifestModel[] = [
  { id: "default-model", name: "Auto", maxOutputTokens: 24_000 },
  { id: "fast-model", name: "Fast", maxOutputTokens: 24_000 },
  { id: "balanced-model", name: "Balanced", maxOutputTokens: 24_000 },
  { id: "primary-model", name: "Primary", maxOutputTokens: 32_000 },
  { id: "deep-model", name: "Deep", maxOutputTokens: 32_000 },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", maxOutputTokens: 32_000 },
  { id: "deepseek-v4.1-flash-sg", name: "DeepSeek V4.1 Flash SG", maxOutputTokens: 32_000 },
  { id: "gpt-6-astra", name: "GPT-6 Astra", maxOutputTokens: 32_000 },
  { id: "hy4-preview", name: "HY4 Preview", maxOutputTokens: 32_000 },
  { id: "hy3", name: "HY3", maxOutputTokens: 32_000 },
  { id: "kimi-k2.8-preview", name: "Kimi K2.8 Preview", maxOutputTokens: 32_000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", maxOutputTokens: 32_000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", maxOutputTokens: 32_000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", maxOutputTokens: 32_000 },
  { id: "gpt-5.5", name: "GPT-5.5", maxOutputTokens: 32_000 },
  { id: "gpt-5.4", name: "GPT-5.4", maxOutputTokens: 32_000 },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", maxOutputTokens: 32_000 },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", maxOutputTokens: 32_000 },
  { id: "glm-5.3", name: "GLM-5.3", maxOutputTokens: 32_000 },
  { id: "glm-5.2", name: "GLM-5.2", maxOutputTokens: 32_000 },
  { id: "kimi-k3", name: "Kimi K3", maxOutputTokens: 32_000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", maxOutputTokens: 32_000 },
];

export const fetchCodebuddyCatalog: ProviderCatalog = async () =>
  MANIFEST.map((model) => ({
    upstreamModel: model.id,
    label: model.name,
    inputPricePerMtok: null,
    cacheInputPricePerMtok: null,
    outputPricePerMtok: null,
    contextWindow: MAX_INPUT_TOKENS,
    maxOutput: model.maxOutputTokens,
    inputModalities: ["text", "image"],
  }));
