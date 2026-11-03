import * as v from "valibot";

export const COOLDOWN_SUBJECTS = ["provider", "model", "credential"] as const;

export const CooldownSubjectSchema = v.picklist(COOLDOWN_SUBJECTS);

/** The upstream call behind a flag: the downstream request it belonged to, and the attempt row. */
export const CooldownLinkSchema = v.object({
  requestId: v.string(),
  attemptId: v.string(),
});

export const CooldownEventSchema = v.object({
  id: v.string(),
  subject: CooldownSubjectSchema,
  subjectName: v.string(),
  providerId: v.string(),
  providerName: v.string(),
  modelId: v.string(),
  modelSlug: v.string(),
  credentialId: v.nullable(v.string()),
  credentialName: v.nullable(v.string()),
  errorKind: v.string(),
  errorMessage: v.nullable(v.string()),
  reference: v.string(),
  failures: v.number(),
  cooldownMs: v.number(),
  /** When the vendor said the exhausted allowance comes back; null when it did not say. */
  resetsAt: v.nullable(v.string()),
  flaggedUntil: v.string(),
  createdAt: v.string(),
});

export const CooldownListSchema = v.object({
  events: v.array(CooldownEventSchema),
});

export const cooldownPaths = {
  list: "/api/cooldowns",
};

export type CooldownSubject = v.InferOutput<typeof CooldownSubjectSchema>;

export type CooldownLink = v.InferOutput<typeof CooldownLinkSchema>;

export type CooldownEvent = v.InferOutput<typeof CooldownEventSchema>;

export type CooldownList = v.InferOutput<typeof CooldownListSchema>;
