import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { cooldownEvents, providerCredentials, providerModels, providers } from "./db/schema";
import type { UpstreamErrorKind } from "./providers/types";

export const COOLDOWN_BASE_MS = 30_000;
export const COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_HISTORY_LIMIT = 500;
export const MAX_ERROR_MESSAGE = 500;

export type Subject =
  | { kind: "provider"; id: string }
  | { kind: "credential"; id: string }
  | { kind: "model"; id: string };

export type FailureTarget = {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialId: string | null;
};

export type FailureContext = {
  readonly userId: string;
  readonly reference: string;
  readonly errorKind: UpstreamErrorKind;
  readonly message?: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelAlias: string;
  readonly credentialId: string | null;
  readonly credentialName: string | null;
};

export type FailureRecord = {
  readonly subject: Subject;
  readonly context: FailureContext;
  readonly now: Date;
};

export function cooldownMs(failures: number): number {
  const growth = COOLDOWN_BASE_MS * 2 ** Math.max(failures - 1, 0);

  return Math.min(growth, COOLDOWN_CAP_MS);
}

export function isCoolingDown(flaggedUntil: Date | null, now: number): boolean {
  return flaggedUntil !== null && flaggedUntil.getTime() > now;
}

export function subjectFor(kind: UpstreamErrorKind, target: FailureTarget): Subject | null {
  switch (kind) {
    case "auth":
    case "rate_limit": {
      return target.credentialId === null ? null : { kind: "credential", id: target.credentialId };
    }

    case "not_found": {
      return { kind: "model", id: target.modelId };
    }

    case "unavailable":
    case "network": {
      return { kind: "provider", id: target.providerId };
    }

    case "protocol": {
      return { kind: "model", id: target.modelId };
    }

    case "invalid_request":
    case "unknown": {
      return null;
    }

    default: {
      const _exhaustive: never = kind;

      return _exhaustive;
    }
  }
}

export function subjectKey(subject: Subject): string {
  return `${subject.kind}:${subject.id}`;
}

export function recordFailure(db: Db, record: FailureRecord): void {
  const { subject, context, now } = record;

  db.transaction((tx) => {
    const failures = failuresOf(tx, subject) + 1;
    const cooldown = cooldownMs(failures);
    const flaggedUntil = new Date(now.getTime() + cooldown);

    updateSubject(tx, subject, failures, flaggedUntil);

    tx.insert(cooldownEvents)
      .values({
        id: crypto.randomUUID(),
        userId: context.userId,
        subject: subject.kind,
        subjectName: subjectNameOf(subject, context),
        providerId: context.providerId,
        providerName: context.providerName,
        modelId: context.modelId,
        modelAlias: context.modelAlias,
        credentialId: context.credentialId,
        credentialName: context.credentialName,
        errorKind: context.errorKind,
        errorMessage: errorMessageOf(context.message),
        reference: context.reference,
        failures,
        cooldownMs: cooldown,
        flaggedUntil,
        createdAt: now,
      })
      .run();

    tx.delete(cooldownEvents)
      .where(
        sql`${cooldownEvents.userId} = ${context.userId} AND ${cooldownEvents.id} NOT IN (
          SELECT ${cooldownEvents.id} FROM ${cooldownEvents}
          WHERE ${cooldownEvents.userId} = ${context.userId}
          ORDER BY ${cooldownEvents.createdAt} DESC, ${cooldownEvents.id} DESC
          LIMIT ${COOLDOWN_HISTORY_LIMIT}
        )`,
      )
      .run();
  });
}

function errorMessageOf(message: string | undefined): string | null {
  return message === undefined ? null : message.slice(0, MAX_ERROR_MESSAGE);
}

function updateSubject(db: Db, subject: Subject, failures: number, flaggedUntil: Date): void {
  switch (subject.kind) {
    case "provider": {
      db.update(providers)
        .set({ failures, flaggedUntil })
        .where(eq(providers.id, subject.id))
        .run();

      return;
    }

    case "model": {
      db.update(providerModels)
        .set({ failures, flaggedUntil })
        .where(eq(providerModels.id, subject.id))
        .run();

      return;
    }

    case "credential": {
      db.update(providerCredentials)
        .set({ failures, flaggedUntil })
        .where(eq(providerCredentials.id, subject.id))
        .run();

      return;
    }

    default: {
      const _exhaustive: never = subject;

      return _exhaustive;
    }
  }
}

export function recordSuccess(db: Db, subjects: readonly Subject[]): void {
  db.transaction((tx) => {
    for (const subject of subjects) {
      switch (subject.kind) {
        case "provider": {
          tx.update(providers)
            .set({ failures: 0, flaggedUntil: null })
            .where(eq(providers.id, subject.id))
            .run();
          break;
        }

        case "model": {
          tx.update(providerModels)
            .set({ failures: 0, flaggedUntil: null })
            .where(eq(providerModels.id, subject.id))
            .run();
          break;
        }

        case "credential": {
          tx.update(providerCredentials)
            .set({ failures: 0, flaggedUntil: null })
            .where(eq(providerCredentials.id, subject.id))
            .run();
          break;
        }

        default: {
          const _exhaustive: never = subject;

          return _exhaustive;
        }
      }
    }
  });
}

function subjectNameOf(subject: Subject, context: FailureContext): string {
  switch (subject.kind) {
    case "provider": {
      return context.providerName;
    }

    case "model": {
      return context.modelAlias;
    }

    case "credential": {
      return context.credentialName ?? "";
    }

    default: {
      const _exhaustive: never = subject;

      return _exhaustive;
    }
  }
}

function failuresOf(db: Db, subject: Subject): number {
  switch (subject.kind) {
    case "provider": {
      const row = db
        .select({ failures: providers.failures })
        .from(providers)
        .where(eq(providers.id, subject.id))
        .get();

      return row?.failures ?? 0;
    }

    case "model": {
      const row = db
        .select({ failures: providerModels.failures })
        .from(providerModels)
        .where(eq(providerModels.id, subject.id))
        .get();

      return row?.failures ?? 0;
    }

    case "credential": {
      const row = db
        .select({ failures: providerCredentials.failures })
        .from(providerCredentials)
        .where(eq(providerCredentials.id, subject.id))
        .get();

      return row?.failures ?? 0;
    }

    default: {
      const _exhaustive: never = subject;

      return _exhaustive;
    }
  }
}
