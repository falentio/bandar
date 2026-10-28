import { apiKeyHeaders } from "../http";
import { always, type GenericProviderDefinition } from "../types";
import { googleAdapter } from "./adapter";

export const google: GenericProviderDefinition<"google"> = {
  kind: "google",
  routes: {
    genai: {
      adapter: googleAdapter({
        kind: "google",
        label: "google",
        headers: apiKeyHeaders("x-goog-api-key"),
      }),
    },
  },
  defaultCompat: always("genai"),
  authModes: ["api-key"],
};
