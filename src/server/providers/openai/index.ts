import type { GenericProviderDefinition } from "../types";
import { openaiAdapter } from "./adapter";

export const openai: GenericProviderDefinition<"openai"> = {
  kind: "openai",
  adapter: openaiAdapter,
  authModes: ["api-key"],
};
