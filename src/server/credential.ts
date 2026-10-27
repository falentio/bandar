import * as v from "valibot";

export const CredentialSchema = v.variant("authMode", [
  v.object({ authMode: v.literal("api-key"), apiKey: v.string() }),
  v.object({
    authMode: v.literal("oauth"),
    accessToken: v.string(),
    organizationId: v.nullable(v.string()),
  }),
]);

export type Credential = v.InferOutput<typeof CredentialSchema>;

export function parseCredential(json: string): Credential | null {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), CredentialSchema), json);

  return parsed.success ? parsed.output : null;
}
