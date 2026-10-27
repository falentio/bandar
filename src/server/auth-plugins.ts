import { apiKey } from "@better-auth/api-key";

export const API_KEY_PREFIX = "bandar_";

export const API_KEY_RATE_LIMIT = { maxRequests: 1000, timeWindow: 3_600_000 } as const;

// `enableSessionForAPIKeys` stays off: a key would then satisfy the session guard
// on /api/auth/* itself, so a leaked key could mint more keys.
export function apiKeyPlugin() {
  return apiKey({
    defaultPrefix: API_KEY_PREFIX,
    startingCharactersConfig: { charactersLength: 11 },
    rateLimit: API_KEY_RATE_LIMIT,
  });
}
