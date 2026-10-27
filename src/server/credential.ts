import * as v from "valibot";

export const CredentialSchema = v.variant("authMode", [
  v.object({ authMode: v.literal("api-key"), apiKey: v.string() }),
  v.object({
    authMode: v.literal("oauth"),
    accessToken: v.string(),
    organizationId: v.nullable(v.string()),
    // A bundle written before renewal carried an expiry has neither field.
    refreshToken: v.optional(v.nullable(v.string()), null),
    expiresAt: v.optional(v.nullable(v.number()), null),
  }),
]);

export type Credential = v.InferOutput<typeof CredentialSchema>;

export type OAuthCredential = Extract<Credential, { authMode: "oauth" }>;

export function parseCredential(json: string): Credential | null {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), CredentialSchema), json);

  return parsed.success ? parsed.output : null;
}
