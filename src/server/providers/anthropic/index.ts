import { apiKeyHeaders } from "../http";
import type { GenericProviderDefinition } from "../types";
import { anthropicAdapter } from "./adapter";

export const anthropic: GenericProviderDefinition<"anthropic"> = {
  kind: "anthropic",
  adapter: anthropicAdapter({
    kind: "anthropic",
    label: "anthropic",
    headers: apiKeyHeaders("x-api-key"),
  }),
  authModes: ["api-key"],
};
