import { BUILT_IN_PROVIDERS } from "../../../shared/providers";
import { apiBaseUrl } from "../env";
import { bearerAdapter } from "../openai/compatible";
import type { BuiltInProviderDefinition } from "../types";
import { fetchNousCatalog } from "./catalog";
import { nousConnector } from "./oauth";
import { nousRenewal } from "./renewal";

const settings = BUILT_IN_PROVIDERS.nous;

export const nous: BuiltInProviderDefinition<"nous"> = {
  kind: "nous",
  // Inference needs a token from the device login; the portal issues no API key.
  authModes: ["oauth"],
  builtIn: {
    name: settings.name,
    slug: settings.slug,
    baseUrl: () => apiBaseUrl("BANDAR_NOUS_API", settings.baseUrl),
  },
  adapter: bearerAdapter("nous", "nous portal"),
  oauth: nousConnector,
  catalog: fetchNousCatalog,
  renew: nousRenewal,
};
