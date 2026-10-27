import { and, desc, eq } from "drizzle-orm";
import type { Provider, ProviderAuthMode, ProviderCredentialInput } from "../shared/providers";
import type { Db } from "./db/client";
import type { Credential } from "./credential";
import { providerCredentials } from "./db/schema";
import { readProvider, sealApiKey, type ProviderDeps } from "./providers";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type AppendedCredential = {
  readonly label: string;
  readonly sealed: string;
  readonly authMode: ProviderAuthMode;
};

export type CredentialWriteResult =
  | { readonly kind: "ok"; readonly provider: Provider }
  | { readonly kind: "missing_provider" }
  | { readonly kind: "missing_credential" }
  | { readonly kind: "invalid_order" };

export async function addProviderCredential(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  input: ProviderCredentialInput,
): Promise<CredentialWriteResult> {
  if ((await readProvider(deps, userId, providerId)) === null) return { kind: "missing_provider" };

  const sealed = await sealApiKey(deps, input.apiKey);

  appendCredentials(deps, providerId, [{ label: input.label ?? "", sealed, authMode: "api-key" }]);

  return reload(deps, userId, providerId);
}

export async function addProviderCredentials(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  apiKeys: readonly string[],
): Promise<CredentialWriteResult> {
  if ((await readProvider(deps, userId, providerId)) === null) return { kind: "missing_provider" };

  const entries = await Promise.all(
    apiKeys.map(async (apiKey): Promise<AppendedCredential> => ({
      label: "",
      sealed: await sealApiKey(deps, apiKey),
      authMode: "api-key",
    })),
  );

  appendCredentials(deps, providerId, entries);

  return reload(deps, userId, providerId);
}

export async function reorderProviderCredentials(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  credentialIds: readonly string[],
): Promise<CredentialWriteResult> {
  const provider = await readProvider(deps, userId, providerId);

  if (provider === null) return { kind: "missing_provider" };

  const requested = new Set(credentialIds);

  if (requested.size !== provider.credentials.length) return { kind: "invalid_order" };

  if (!provider.credentials.every((entry) => requested.has(entry.id))) {
    return { kind: "invalid_order" };
  }

  deps.db.transaction((tx) => {
    writeRanks(tx, providerId, provider.credentials, credentialIds);
  });

  return reload(deps, userId, providerId);
}

export async function removeProviderCredential(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  credentialId: string,
): Promise<CredentialWriteResult> {
  const provider = await readProvider(deps, userId, providerId);

  if (provider === null) return { kind: "missing_provider" };

  const remaining = provider.credentials.filter((entry) => entry.id !== credentialId);

  if (remaining.length === provider.credentials.length) return { kind: "missing_credential" };

  deps.db.transaction((tx) => {
    tx.delete(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, credentialId),
          eq(providerCredentials.providerId, providerId),
        ),
      )
      .run();

    writeRanks(
      tx,
      providerId,
      remaining,
      remaining.map((entry) => entry.id),
    );
  });

  return reload(deps, userId, providerId);
}

export async function addOAuthCredential(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
  credential: Credential,
): Promise<Provider | null> {
  const provider = await readProvider(deps, userId, providerId);

  if (provider === null) return null;

  const sealed = await deps.sealer.seal(JSON.stringify(credential));

  appendCredentials(deps, providerId, [{ label: "", sealed, authMode: credential.authMode }]);

  return readProvider(deps, userId, providerId);
}

function writeRanks(
  tx: Tx,
  providerId: string,
  current: readonly { readonly id: string; readonly priority: number }[],
  order: readonly string[],
): void {
  // The unique index is live during the update, so every rank leaves the 1..N range first.
  for (const entry of current) {
    tx.update(providerCredentials)
      .set({ priority: -entry.priority })
      .where(eq(providerCredentials.id, entry.id))
      .run();
  }

  for (const [index, credentialId] of order.entries()) {
    tx.update(providerCredentials)
      .set({ priority: index + 1 })
      .where(
        and(
          eq(providerCredentials.id, credentialId),
          eq(providerCredentials.providerId, providerId),
        ),
      )
      .run();
  }
}

function appendCredentials(
  deps: ProviderDeps,
  providerId: string,
  entries: readonly AppendedCredential[],
): void {
  deps.db.transaction((tx) => {
    const highest = tx
      .select({ priority: providerCredentials.priority })
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, providerId))
      .orderBy(desc(providerCredentials.priority))
      .limit(1)
      .all()[0];

    const base = highest?.priority ?? 0;
    const now = new Date();

    tx.insert(providerCredentials)
      .values(
        entries.map((entry, index) => ({
          id: crypto.randomUUID(),
          providerId,
          label: entry.label,
          credential: entry.sealed,
          authMode: entry.authMode,
          priority: base + index + 1,
          createdAt: now,
        })),
      )
      .run();
  });
}

async function reload(
  deps: ProviderDeps,
  userId: string,
  providerId: string,
): Promise<CredentialWriteResult> {
  const provider = await readProvider(deps, userId, providerId);

  return provider === null ? { kind: "missing_provider" } : { kind: "ok", provider };
}
