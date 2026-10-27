/** An env-pinned origin carrying the provider's `/v1` path, or the default base URL. */
export function apiBaseUrl(name: string, fallback: string): string {
  const origin = originOf(name);

  return origin === null ? fallback : `${origin}/v1`;
}

/** An env-pinned origin for a provider's non-API surface, such as its login portal. */
export function originUrl(name: string, fallback: string): string {
  return originOf(name) ?? fallback;
}

function originOf(name: string): string | null {
  const value = Bun.env[name]?.trim().replace(/\/+$/, "");

  return value === undefined || value === "" ? null : value;
}
