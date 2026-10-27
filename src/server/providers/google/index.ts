import type { GenericProviderDefinition } from "../types";
import { googleAdapter } from "./adapter";

export const google: GenericProviderDefinition = {
  kind: "google",
  adapter: googleAdapter,
};
