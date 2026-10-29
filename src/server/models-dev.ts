import * as v from "valibot";

export type ModelLimits = {
  readonly contextWindow: number | null;
  readonly maxOutput: number | null;
};

export type ProviderLimit = ModelLimits & {
  readonly providerId: string;
  readonly providerName: string;
};

export const NO_LIMITS: ModelLimits = { contextWindow: null, maxOutput: null };

export const MODELS_DEV_URL = "https://models.dev/api.json";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const LimitSchema = v.object({
  context: v.optional(v.nullable(v.number())),
  output: v.optional(v.nullable(v.number())),
});

const ModelSchema = v.object({ limit: v.optional(v.nullable(LimitSchema)) });

const ProviderSchema = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  models: v.record(v.string(), ModelSchema),
});

export const ModelsDevPayloadSchema = v.record(v.string(), ProviderSchema);

export type ModelsDevPayload = v.InferOutput<typeof ModelsDevPayloadSchema>;

export function parseModelLimits(
  payload: ModelsDevPayload,
): ReadonlyMap<string, readonly ProviderLimit[]> {
  const limits = new Map<string, ProviderLimit[]>();

  for (const [key, provider] of Object.entries(payload)) {
    const providerId = provider.id ?? key;
    const providerName = provider.name ?? providerId;

    for (const [modelId, model] of Object.entries(provider.models)) {
      const contextWindow = model.limit?.context ?? null;
      const maxOutput = model.limit?.output ?? null;

      if (contextWindow === null && maxOutput === null) continue;

      const entries = limits.get(modelId) ?? [];
      entries.push({ providerId, providerName, contextWindow, maxOutput });
      limits.set(modelId, entries);
    }
  }

  return limits;
}

type Cached = {
  readonly values: ReadonlyMap<string, readonly ProviderLimit[]>;
  readonly expiresAt: number;
};

let cached: Cached | null = null;
let inFlight: Promise<Cached> | null = null;

async function catalog(): Promise<Cached> {
  const now = Date.now();

  if (cached !== null && cached.expiresAt > now) return cached;

  if (inFlight !== null) return inFlight;

  inFlight = fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((payload) => {
      const parsed = v.safeParse(ModelsDevPayloadSchema, payload);

      return {
        values: parsed.success ? parseModelLimits(parsed.output) : new Map(),
        expiresAt: now + CACHE_TTL_MS,
      };
    })
    .catch(() => ({
      values: new Map<string, readonly ProviderLimit[]>(),
      expiresAt: now + CACHE_TTL_MS,
    }))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export async function lookupModelLimits(
  ids: readonly string[],
  providerHint?: string,
): Promise<ReadonlyMap<string, ModelLimits>> {
  const { values } = await catalog();
  const found = new Map<string, ModelLimits>();

  for (const id of ids) {
    const entries = values.get(id);

    if (entries === undefined) continue;

    const chosen = pickModelLimit(entries, providerHint);

    if (chosen === null) continue;

    found.set(id, { contextWindow: chosen.contextWindow, maxOutput: chosen.maxOutput });
  }

  return found;
}

export function pickModelLimit(
  entries: readonly ProviderLimit[],
  providerHint: string | undefined,
): ProviderLimit | null {
  const needle = providerHint?.trim().toLowerCase() ?? "";

  if (needle !== "") {
    const named = entries.find(
      (entry) =>
        entry.providerId.toLowerCase() === needle || entry.providerName.toLowerCase() === needle,
    );

    if (named !== undefined) return named;
  }

  // An aggregator can publish a window several times the model's own, so take the smallest claim: a
  // short window only truncates, a long one makes the tool send a request the model rejects.
  return entries.reduce<ProviderLimit | null>((best, entry) => {
    if (best === null) return entry;

    const context = entry.contextWindow ?? Number.POSITIVE_INFINITY;
    const bestContext = best.contextWindow ?? Number.POSITIVE_INFINITY;

    if (context < bestContext) return entry;

    if (context === bestContext) {
      const output = entry.maxOutput ?? Number.POSITIVE_INFINITY;
      const bestOutput = best.maxOutput ?? Number.POSITIVE_INFINITY;

      if (output < bestOutput) return entry;
    }

    return best;
  }, null);
}
