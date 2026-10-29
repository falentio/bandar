export type ProjectUrlCatalog = { list(userId: string): readonly string[] };

type CatalogOptions = {
  readonly ttlMs?: number;
  readonly now?: () => number;
};

type Entry = {
  readonly urls: readonly string[];
  readonly readAt: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;

export function createProjectUrlCatalog(
  read: (userId: string) => readonly string[],
  options: CatalogOptions = {},
): ProjectUrlCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  return {
    list(userId) {
      const at = now();
      const entry = entries.get(userId);

      if (entry !== undefined && at - entry.readAt < ttlMs) return entry.urls;

      dropExpired(entries, at, ttlMs);

      const urls = read(userId);

      entries.set(userId, { urls, readAt: at });

      return urls;
    },
  };
}

function dropExpired(entries: Map<string, Entry>, at: number, ttlMs: number): void {
  for (const [userId, entry] of entries) {
    if (at - entry.readAt >= ttlMs) entries.delete(userId);
  }
}
