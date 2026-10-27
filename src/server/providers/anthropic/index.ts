import type { GenericProviderDefinition } from "../types";
import { anthropicAdapter } from "./adapter";

export const anthropic: GenericProviderDefinition<"anthropic"> = {
  kind: "anthropic",
  adapter: anthropicAdapter,
};
