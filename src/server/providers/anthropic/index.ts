import type { GenericProviderDefinition } from "../types";
import { anthropicAdapter } from "./adapter";

export const anthropic: GenericProviderDefinition = {
  kind: "anthropic",
  adapter: anthropicAdapter,
};
