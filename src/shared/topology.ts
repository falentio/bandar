export const DEFAULT_API_PORT = 3000;
export const DEFAULT_WEB_PORT = 5173;

export const MIN_PORT = 0;
export const MAX_PORT = 65535;

export const loopbackOrigin = (port: number): string => `http://127.0.0.1:${port}`;
