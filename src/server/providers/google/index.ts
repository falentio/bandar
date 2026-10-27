import { apiKeyHeaders } from "../http";
import type { GenericProviderDefinition } from "../types";
import { googleAdapter } from "./adapter";

export const google: GenericProviderDefinition<"google"> = {
  kind: "google",
  adapter: googleAdapter({
    kind: "google",
    label: "google",
    headers: apiKeyHeaders("x-goog-api-key"),
  }),
  authModes: ["api-key"],
};
