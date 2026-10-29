export const DEFAULT_API_PORT = 4133;
export const DEV_WEB_PORT = 5173;
export const DEFAULT_HOST = "0.0.0.0";

export const MIN_PORT = 0;
export const MAX_PORT = 65535;

export const httpOrigin = (host: string, port: number): string =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

export const loopbackOrigin = (port: number): string => httpOrigin("127.0.0.1", port);

/** A wildcard bind listens on every interface, so its own address is not an origin to open. */
export const isWildcardHost = (host: string): boolean => host === "0.0.0.0" || host === "::";

export const originForHost = (host: string, port: number): string =>
  httpOrigin(isWildcardHost(host) ? "127.0.0.1" : host, port);

/**
 * The auth URL a run falls back to: loopback on the resolved port. The schema's help text names the
 * port as a placeholder, which is why the argument takes it as a string too.
 */
export const authUrlForPort = (port: number | "<port>"): string =>
  `http://localhost:${String(port)}`;
