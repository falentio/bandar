import { BUILT_IN_PROVIDER_KINDS, type ProviderKind } from "../../shared/providers";
import { TAG_SLUG } from "../../shared/slugs";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { kilocode } from "./kilocode";
import { nous } from "./nous";
import { openai } from "./openai";
import { river } from "./river";
import { tokenharbor } from "./tokenharbor";
import { yeta } from "./yeta";
import type {
  BuiltInProviderDefinition,
  BuiltInProviderDefinitions,
  GenericProviderDefinitions,
  ProviderDefinitionRecord,
} from "./types";

const genericDefinitions = {
  anthropic,
  openai,
  google,
} satisfies GenericProviderDefinitions;

const builtInDefinitions = {
  kilocode,
  tokenharbor,
  yeta,
  river,
  nous,
} satisfies BuiltInProviderDefinitions;

const providerDefinitions: ProviderDefinitionRecord = {
  ...genericDefinitions,
  ...builtInDefinitions,
};

export function definitionFor<K extends ProviderKind>(kind: K): ProviderDefinitionRecord[K] {
  return providerDefinitions[kind];
}

export const builtInProviders: readonly BuiltInProviderDefinition[] = BUILT_IN_PROVIDER_KINDS.map(
  (kind) => definitionFor(kind),
);

export const reservedProviderSlugs: ReadonlySet<string> = new Set([
  TAG_SLUG,
  ...builtInProviders.map((definition) => definition.builtIn.slug),
]);
