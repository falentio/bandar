import * as v from "valibot";

export const COOLDOWN_SUBJECTS = ["provider", "model", "credential"] as const;

export const CooldownSubjectSchema = v.picklist(COOLDOWN_SUBJECTS);

export const CooldownEventSchema = v.object({
  id: v.string(),
  subject: CooldownSubjectSchema,
  subjectName: v.string(),
  providerId: v.string(),
  providerName: v.string(),
  modelId: v.string(),
  modelAlias: v.string(),
  credentialId: v.nullable(v.string()),
  credentialName: v.nullable(v.string()),
  errorKind: v.string(),
  errorMessage: v.nullable(v.string()),
  reference: v.string(),
  failures: v.number(),
  cooldownMs: v.number(),
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

export type CooldownEvent = v.InferOutput<typeof CooldownEventSchema>;

export type CooldownList = v.InferOutput<typeof CooldownListSchema>;
