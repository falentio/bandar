import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import type {
  ActiveCooldown,
  CooldownEvent,
  CooldownList,
  CooldownSubject,
} from "../shared/cooldowns";
import type { Db } from "./db/client";
import { cooldownEvents, providerCredentials, providerModels, providers } from "./db/schema";

export async function readCooldowns(
  db: Db,
  userId: string,
  limit: number,
  now = new Date(),
): Promise<CooldownList> {
  const active = await readActive(db, userId, now);
  const events = await readEvents(db, userId, limit);

  return { active, events };
}

async function readEvents(db: Db, userId: string, limit: number): Promise<CooldownEvent[]> {
  const rows = await db
    .select()
    .from(cooldownEvents)
    .where(eq(cooldownEvents.userId, userId))
    .orderBy(desc(cooldownEvents.createdAt), desc(cooldownEvents.id))
    .limit(limit);

  return rows.map(eventOf);
}

async function readActive(db: Db, userId: string, now: Date): Promise<ActiveCooldown[]> {
  const flaggedProviders = await db
    .select({
      id: providers.id,
      name: providers.name,
      failures: providers.failures,
      flaggedUntil: providers.flaggedUntil,
    })
    .from(providers)
    .where(and(eq(providers.userId, userId), gt(providers.flaggedUntil, now)));

  const flaggedModels = await db
    .select({
      id: providerModels.id,
      slug: providerModels.slug,
      providerId: providers.id,
      providerName: providers.name,
      failures: providerModels.failures,
      flaggedUntil: providerModels.flaggedUntil,
    })
    .from(providerModels)
    .innerJoin(providers, eq(providers.id, providerModels.providerId))
    .where(and(eq(providerModels.userId, userId), gt(providerModels.flaggedUntil, now)));

  const flaggedCredentials = await db
    .select({
      id: providerCredentials.id,
      label: providerCredentials.label,
      providerId: providers.id,
      providerName: providers.name,
      failures: providerCredentials.failures,
      flaggedUntil: providerCredentials.flaggedUntil,
    })
    .from(providerCredentials)
    .innerJoin(providers, eq(providers.id, providerCredentials.providerId))
    .where(and(eq(providers.userId, userId), gt(providerCredentials.flaggedUntil, now)));

  const flagged: readonly FlaggedRow[] = [
    ...flaggedProviders.map((row): FlaggedRow => ({
      subject: "provider",
      subjectId: row.id,
      subjectName: row.name,
      providerId: row.id,
      providerName: row.name,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil,
    })),
    ...flaggedModels.map((row): FlaggedRow => ({
      subject: "model",
      subjectId: row.id,
      subjectName: row.slug,
      providerId: row.providerId,
      providerName: row.providerName,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil,
    })),
    ...flaggedCredentials.map((row): FlaggedRow => ({
      subject: "credential",
      subjectId: row.id,
      subjectName: row.label,
      providerId: row.providerId,
      providerName: row.providerName,
      failures: row.failures,
      flaggedUntil: row.flaggedUntil,
    })),
  ];

  const listed = flagged.flatMap((row) =>
    row.flaggedUntil === null
      ? []
      : [{ ...row, flaggedUntil: row.flaggedUntil.toISOString(), lastEvent: null }],
  );

  const lastEvents = await readLastEvents(db, userId, listed);

  return listed
    .map((row): ActiveCooldown => ({
      ...row,
      lastEvent: lastEvents.get(subjectKey(row.subject, row.subjectId)) ?? null,
    }))
    .sort((left, right) => {
      if (left.failures !== right.failures) return right.failures - left.failures;

      return left.flaggedUntil.localeCompare(right.flaggedUntil);
    });
}

type FlaggedRow = {
  readonly subject: CooldownSubject;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly failures: number;
  readonly flaggedUntil: Date | null;
};

async function readLastEvents(
  db: Db,
  userId: string,
  listed: readonly ActiveCooldown[],
): Promise<Map<string, CooldownEvent>> {
  const idsOf = (subject: CooldownSubject) =>
    listed.flatMap((row) => (row.subject === subject ? [row.subjectId] : []));

  const providerIds = idsOf("provider");
  const modelIds = idsOf("model");
  const credentialIds = idsOf("credential");

  const subjects = [
    providerIds.length === 0
      ? undefined
      : and(
          eq(cooldownEvents.subject, "provider"),
          inArray(cooldownEvents.providerId, providerIds),
        ),
    modelIds.length === 0
      ? undefined
      : and(eq(cooldownEvents.subject, "model"), inArray(cooldownEvents.modelId, modelIds)),
    credentialIds.length === 0
      ? undefined
      : and(
          eq(cooldownEvents.subject, "credential"),
          inArray(cooldownEvents.credentialId, credentialIds),
        ),
  ].flatMap((clause) => (clause === undefined ? [] : [clause]));

  if (subjects.length === 0) return new Map();

  const rows = await db
    .select()
    .from(cooldownEvents)
    .where(and(eq(cooldownEvents.userId, userId), or(...subjects)))
    .orderBy(desc(cooldownEvents.createdAt), desc(cooldownEvents.id));

  const newest = new Map<string, CooldownEvent>();

  for (const row of rows) {
    const event = eventOf(row);
    const key = subjectKey(event.subject, subjectIdOf(event));

    if (!newest.has(key)) newest.set(key, event);
  }

  return newest;
}

function subjectKey(subject: CooldownSubject, subjectId: string): string {
  return `${subject}:${subjectId}`;
}

function subjectIdOf(event: CooldownEvent): string {
  switch (event.subject) {
    case "provider": {
      return event.providerId;
    }

    case "model": {
      return event.modelId;
    }

    case "credential": {
      return event.credentialId ?? "";
    }

    default: {
      const _exhaustive: never = event.subject;

      return _exhaustive;
    }
  }
}

function eventOf(row: typeof cooldownEvents.$inferSelect): CooldownEvent {
  return {
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
    resetsAt: row.resetsAt?.toISOString() ?? null,
    flaggedUntil: row.flaggedUntil.toISOString(),
    createdAt: row.createdAt.toISOString(),
    attempt:
      row.attemptId === null || row.downstreamRequestId === null
        ? null
        : { requestId: row.downstreamRequestId, attemptId: row.attemptId },
  };
}
