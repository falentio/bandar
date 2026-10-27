import { and, eq } from "drizzle-orm";
import type { Credential, OAuthCredential } from "../credential";
import { providerCredentials } from "../db/schema";
import type { ResolvedAttempt } from "../router/resolve";
import { readCredential, type ProviderDeps } from ".";
import { definitionFor } from "./registry";
import { UpstreamError } from "./types";
import type { CredentialRenewer } from "./types";

const RENEWAL_TIMEOUT_MS = 15_000;

// One renewal per credential row: a burst of requests shares the same rotate-and-store.
const inFlight = new Map<string, Promise<Credential>>();

/** The credential an attempt calls with, renewed first when it is due. */
export async function freshCredential(
  deps: ProviderDeps,
  attempt: ResolvedAttempt,
): Promise<Credential> {
  const stored = await readCredential(deps, attempt.sealedKey);

  if (attempt.credentialId === null || stored.authMode !== "oauth") return stored;

  const renewer = definitionFor(attempt.kind).renew;

  if (renewer === undefined || !renewer.due(stored, Date.now())) return stored;

  const credentialId = attempt.credentialId;
  const pending = inFlight.get(credentialId);

  if (pending !== undefined) return pending;

  const renewal = renewOnce(deps, attempt, credentialId, stored, renewer).finally(() => {
    inFlight.delete(credentialId);
  });

  inFlight.set(credentialId, renewal);

  return renewal;
}

async function renewOnce(
  deps: ProviderDeps,
  attempt: ResolvedAttempt,
  credentialId: string,
  current: OAuthCredential,
  renewer: CredentialRenewer,
): Promise<Credential> {
  const stored = await sealedCredential(deps, credentialId);

  if (stored === null) {
    throw new UpstreamError("the credential was removed before it could be renewed", "auth");
  }

  // Another request rotated it while this one waited for the slot.
  if (stored !== attempt.sealedKey) return readCredential(deps, stored);

  const renewed = await renewer.renew({
    providerId: attempt.providerId,
    credential: current,
    signal: AbortSignal.timeout(RENEWAL_TIMEOUT_MS),
  });

  const sealed = await deps.sealer.seal(JSON.stringify(renewed));

  const updated = await deps.db
    .update(providerCredentials)
    .set({ credential: sealed, authMode: "oauth" })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.credential, attempt.sealedKey),
      ),
    )
    .returning({ id: providerCredentials.id });

  if (updated.length > 0) return renewed;

  // The row moved between the read and the write, so the stored bundle is the fresher one.
  const raced = await sealedCredential(deps, credentialId);

  if (raced === null) {
    throw new UpstreamError("the credential was removed while it renewed", "auth");
  }

  return readCredential(deps, raced);
}

async function sealedCredential(deps: ProviderDeps, credentialId: string): Promise<string | null> {
  const rows = await deps.db
    .select({ credential: providerCredentials.credential })
    .from(providerCredentials)
    .where(eq(providerCredentials.id, credentialId))
    .limit(1);

  return rows[0]?.credential ?? null;
}
