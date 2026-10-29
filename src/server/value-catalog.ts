export type ValueCatalog = { list(userId: string): readonly string[] };

type CatalogOptions = {
  readonly ttlMs?: number;
  readonly now?: () => number;
};

type Entry = {
  readonly values: readonly string[];
  readonly readAt: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;

export function createValueCatalog(
  read: (userId: string) => readonly string[],
  options: CatalogOptions = {},
): ValueCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  return {
    list(userId) {
      const at = now();
      const entry = entries.get(userId);

      if (entry !== undefined && at - entry.readAt < ttlMs) return entry.values;

      dropExpired(entries, at, ttlMs);

      const values = read(userId);

      entries.set(userId, { values, readAt: at });

      return values;
    },
  };
}

function dropExpired(entries: Map<string, Entry>, at: number, ttlMs: number): void {
  for (const [userId, entry] of entries) {
    if (at - entry.readAt >= ttlMs) entries.delete(userId);
  }
}
