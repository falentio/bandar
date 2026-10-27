import type { GenericProviderDefinition } from "../types";
import { googleAdapter } from "./adapter";

export const google: GenericProviderDefinition<"google"> = {
  kind: "google",
  adapter: googleAdapter,
  authModes: ["api-key"],
};
