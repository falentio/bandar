import type { GenericProviderDefinition } from "../types";
import { openaiAdapter } from "./adapter";

export const openai: GenericProviderDefinition = {
  kind: "openai",
  adapter: openaiAdapter,
};
