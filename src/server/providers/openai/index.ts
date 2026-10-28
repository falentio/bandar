import { bearerHeaders } from "../http";
import { always, type GenericProviderDefinition } from "../types";
import { openaiAdapter } from "./adapter";
import { responsesAdapter } from "./responses";

export const openai: GenericProviderDefinition<"openai"> = {
  kind: "openai",
  routes: {
    chat: { adapter: openaiAdapter },
    responses: {
      adapter: responsesAdapter({ kind: "openai", label: "openai", headers: bearerHeaders }),
    },
  },
  defaultCompat: always("chat"),
  authModes: ["api-key"],
};
