import { apiKeyHeaders } from "../http";
import { always, type GenericProviderDefinition } from "../types";
import { anthropicAdapter } from "./adapter";

export const anthropic: GenericProviderDefinition<"anthropic"> = {
  kind: "anthropic",
  routes: {
    messages: {
      adapter: anthropicAdapter({
        kind: "anthropic",
        label: "anthropic",
        headers: apiKeyHeaders("x-api-key"),
      }),
    },
  },
  defaultCompat: always("messages"),
  authModes: ["api-key"],
};
