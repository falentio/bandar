import { desc, eq } from "drizzle-orm";
import type { CooldownEvent, CooldownList } from "../shared/cooldowns";
import type { Db } from "./db/client";
import { cooldownEvents } from "./db/schema";

export async function readCooldowns(db: Db, userId: string, limit: number): Promise<CooldownList> {
  const rows = await db
    .select()
    .from(cooldownEvents)
    .where(eq(cooldownEvents.userId, userId))
    .orderBy(desc(cooldownEvents.createdAt), desc(cooldownEvents.id))
    .limit(limit);

  return {
    events: rows.map((row): CooldownEvent => ({
      id: row.id,
      subject: row.subject,
      subjectName: row.subjectName,
      providerId: row.providerId,
      providerName: row.providerName,
      modelId: row.modelId,
      modelSlug: row.modelSlug,
      credentialId: row.credentialId,
      credentialName: row.credentialName,
      errorKind: row.errorKind,
      errorMessage: row.errorMessage,
      reference: row.reference,
      failures: row.failures,
      cooldownMs: row.cooldownMs,
      flaggedUntil: row.flaggedUntil.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
