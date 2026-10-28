import { and, eq } from "drizzle-orm";
import type { Provider, ProviderCredentialProbe } from "../../shared/providers";
import type { Credential } from "../credential";
import { providerCredentials } from "../db/schema";
import { readCredential, type ProviderDeps } from "./index";
import { definitionFor } from "./registry";
import { UpstreamError } from "./types";

/** One token of one model is the cheapest read every wire answers the same way. */
const PROBE_REQUEST = { messages: [{ role: "user", content: "ping" }], maxTokens: 1 } as const;

const NO_MODEL = "add a model to this provider before testing the credential";

type ProbeRead = Omit<ProviderCredentialProbe, "latencyMs">;

const PASSED: ProbeRead = { ok: true, status: null, error: null };

/**
 * Spend one request against a single saved credential. It runs outside the
 * gateway, so it records no analytics row and flags no subject for cooldown.
 * A null result means the credential is not on this provider.
 */
export async function probeProviderCredential(
  deps: ProviderDeps,
  provider: Provider,
  credentialId: string,
  signal: AbortSignal,
): Promise<ProviderCredentialProbe | null> {
  const row = await deps.db
    .select({ credential: providerCredentials.credential })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.providerId, provider.id),
      ),
    )
    .limit(1);

  const sealed = row[0]?.credential;

  if (sealed === undefined) return null;

  const started = performance.now();

  try {
    const read = await probeRead(provider, await readCredential(deps, sealed), signal);

    return { ...read, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : "the credential could not be read",
    };
  }
}

async function probeRead(
  provider: Provider,
  credential: Credential,
  signal: AbortSignal,
): Promise<ProbeRead> {
  const model = provider.models[0];

  try {
    if (model === undefined) {
      const catalog = definitionFor(provider.kind).catalog;

      if (catalog === undefined) return { ok: false, status: null, error: NO_MODEL };

      await catalog({ baseUrl: provider.baseUrl, credential: async () => credential, signal });

      return PASSED;
    }

    await definitionFor(provider.kind).adapter.chat({
      target: {
        providerId: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        credential,
        upstreamModel: model.upstreamModel,
      },
      request: PROBE_REQUEST,
      signal,
    });

    return PASSED;
  } catch (error) {
    if (error instanceof UpstreamError) {
      return { ok: false, status: error.status, error: error.message };
    }

    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "the test failed",
    };
  }
}
