import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { providerCredentials, providerModels, providers } from "./db/schema";
import type { UpstreamErrorKind } from "./providers/types";

export const COOLDOWN_BASE_MS = 30_000;
export const COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;

export type Health = { failures: number; flaggedUntil: Date | null };

export type Subject =
  | { kind: "provider"; id: string }
  | { kind: "credential"; id: string }
  | { kind: "model"; id: string };

export type FailureTarget = {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialId: string | null;
};

export function cooldownMs(failures: number): number {
  const growth = COOLDOWN_BASE_MS * 2 ** Math.max(failures - 1, 0);

  return Math.min(growth, COOLDOWN_CAP_MS);
}

export function isCoolingDown(health: Health, now: number): boolean {
  return health.flaggedUntil !== null && health.flaggedUntil.getTime() > now;
}

export function subjectFor(kind: UpstreamErrorKind, target: FailureTarget): Subject | null {
  switch (kind) {
    case "auth":
    case "rate_limit": {
      return target.credentialId === null ? null : { kind: "credential", id: target.credentialId };
    }

    case "unavailable":
    case "network": {
      return { kind: "provider", id: target.providerId };
    }

    case "protocol": {
      return { kind: "model", id: target.modelId };
    }

    case "invalid_request": {
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

export function recordFailure(db: Db, subject: Subject, now: Date): void {
  const failures = failuresOf(db, subject) + 1;
  const flaggedUntil = new Date(now.getTime() + cooldownMs(failures));

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
  for (const subject of subjects) {
    switch (subject.kind) {
      case "provider": {
        db.update(providers)
          .set({ failures: 0, flaggedUntil: null })
          .where(eq(providers.id, subject.id))
          .run();
        break;
      }

      case "model": {
        db.update(providerModels)
          .set({ failures: 0, flaggedUntil: null })
          .where(eq(providerModels.id, subject.id))
          .run();
        break;
      }

      case "credential": {
        db.update(providerCredentials)
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
