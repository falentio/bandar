import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one attempt sent upstream and what came back, as text, for the request log. Both halves are
 * capped: a prompt or a stream can be megabytes, and one log row is not the place for megabytes.
 */
export type Exchange = {
  readonly requestUrl: string;
  readonly requestHeaders: string;
  readonly requestBody: string;
  readonly responseStatus: number | null;
  readonly responseBody: string | null;
  readonly truncated: boolean;
};

export type Capture = {
  request: { url: string; headers: string; body: string } | null;
  response: { status: number; body: string } | null;
  truncated: boolean;
  reading: Promise<void> | null;
};

export const MAX_CAPTURE_CHARS = 256 * 1024;

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

/**
 * The capture for the attempt being routed. AsyncLocalStorage is what keeps the adapters free of
 * it: every adapter reaches upstream through postJson, which reads this store, so capturing a call
 * costs one scope here instead of a parameter through every wire.
 */
const store = new AsyncLocalStorage<Capture>();

export function newCapture(): Capture {
  return { request: null, response: null, truncated: false, reading: null };
}

export function currentCapture(): Capture | undefined {
  return store.getStore();
}

/** Runs one upstream call with the capture active. A failure keeps what was captured so far. */
export async function inCapture<T>(capture: Capture, run: () => Promise<T>): Promise<T> {
  return store.run(capture, run);
}

export function noteRequest(
  capture: Capture,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): void {
  capture.request = {
    url,
    headers: JSON.stringify(redactHeaders(headers), null, 2),
    body: clip(body, capture),
  };
}

/** Copies a response body into the capture as the caller reads its own branch of the tee. */
export function noteResponse(
  capture: Capture,
  response: Response,
  branch: ReadableStream<Uint8Array>,
): void {
  capture.reading = (async () => {
    const reader = branch.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;

        const room = MAX_CAPTURE_CHARS - text.length;

        if (value.length > room) {
          capture.truncated = true;
          text += decoder.decode(value.slice(0, room));

          break;
        }

        text += decoder.decode(value, { stream: true });
      }
    } catch {
      capture.truncated = true;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    capture.response = { status: response.status, body: text };
  })();
}

/** Null when the attempt never reached upstream, such as a provider with no credential. */
export async function exchangeOf(capture: Capture): Promise<Exchange | null> {
  if (capture.reading !== null) await capture.reading;

  const request = capture.request;

  if (request === null) return null;

  return {
    requestUrl: request.url,
    requestHeaders: request.headers,
    requestBody: request.body,
    responseStatus: capture.response?.status ?? null,
    responseBody: capture.response?.body ?? null,
    truncated: capture.truncated,
  };
}

function clip(text: string, capture: Capture): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text;

  capture.truncated = true;

  return text.slice(0, MAX_CAPTURE_CHARS);
}

function redactHeaders(headers: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SECRET_HEADERS.has(name.toLowerCase()) ? maskSecret(value) : value,
    ]),
  );
}

function maskSecret(value: string): string {
  const scheme = /^(Bearer|Basic)\s/i.exec(value)?.[1];

  return scheme === undefined ? "••••" : `${scheme} ••••`;
}
