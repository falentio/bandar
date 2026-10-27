import type { ProviderKind } from "../../../shared/providers";
import type { ProviderAdapter } from "../types";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { kilocode } from "./kilocode";
import { openai } from "./openai";

const adapters = {
  openai,
  anthropic,
  google,
  kilocode,
} satisfies Record<ProviderKind, ProviderAdapter>;

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return adapters[kind];
}
