import { BUILT_IN_PROVIDER_KINDS, type ProviderKind } from "../../shared/providers";
import { TAG_SLUG } from "../../shared/slugs";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { kilocode } from "./kilocode";
import { openai } from "./openai";
import type { BuiltInProviderDefinition, ProviderDefinition } from "./types";

const providerDefinitions = {
  openai,
  anthropic,
  google,
  kilocode,
} satisfies Record<ProviderKind, ProviderDefinition>;

type ProviderDefinitions = typeof providerDefinitions;

export function definitionFor<K extends ProviderKind>(kind: K): ProviderDefinitions[K] {
  return providerDefinitions[kind];
}

export const builtInProviders: readonly BuiltInProviderDefinition[] = BUILT_IN_PROVIDER_KINDS.map(
  (kind) => definitionFor(kind),
);

export const reservedProviderSlugs: ReadonlySet<string> = new Set([
  TAG_SLUG,
  ...builtInProviders.map((definition) => definition.builtIn.slug),
]);
