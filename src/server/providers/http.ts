import * as v from "valibot";
import type { Credential } from "../credential";
import { UpstreamError, type UpstreamErrorKind } from "./types";

const ErrorBodySchema = v.object({
  error: v.optional(v.object({ message: v.optional(v.string()), type: v.optional(v.string()) })),
  message: v.optional(v.string()),
});

export type JsonPost = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
};

export type FormPost = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly form: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function postJson(request: JsonPost): Promise<Response> {
  return send(
    request.url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...request.headers },
      body: request.body,
    },
    request.signal,
  );
}

export async function postForm(request: FormPost): Promise<Response> {
  return send(
    request.url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...request.headers },
      body: new URLSearchParams(request.form).toString(),
    },
    request.signal,
  );
}

export async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;

  const message = await errorMessage(response);
  throw new UpstreamError(message, kindForStatus(response.status), response.status);
}

async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new UpstreamError("request aborted", "network");

    throw new UpstreamError(
      error instanceof Error ? error.message : "upstream request failed",
      "network",
    );
  }
}

export function protocolError(message: string): UpstreamError {
  return new UpstreamError(message, "protocol");
}

export function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw protocolError("upstream returned an empty stream");

  return response.body;
}

export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data !== "") yield data;

        boundary = buffer.indexOf("\n\n");
      }

      if (signal.aborted) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** An API key and an OAuth token both travel as one bearer-like secret. */
export function secretOf(credential: Credential): string {
  return credential.authMode === "api-key" ? credential.apiKey : credential.accessToken;
}

export type WireHeaders = Readonly<Record<string, string>>;

/** Auth headers for one credential. A wire adds its own protocol headers. */
export type HeaderFactory = (credential: Credential) => WireHeaders;

export function bearerHeaders(credential: Credential): WireHeaders {
  const secret = secretOf(credential);

  return secret === "" ? {} : { authorization: `Bearer ${secret}` };
}

export function apiKeyHeaders(name: string): HeaderFactory {
  return (credential) => {
    const secret = secretOf(credential);

    return secret === "" ? {} : { [name]: secret };
  };
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();

  if (text === "") return `upstream returned ${response.status}`;

  try {
    const parsed = v.safeParse(ErrorBodySchema, JSON.parse(text));

    if (parsed.success) {
      return (
        parsed.output.error?.message ??
        parsed.output.message ??
        `upstream returned ${response.status}`
      );
    }
  } catch {
    return text.slice(0, 300);
  }

  return text.slice(0, 300);
}

function kindForStatus(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return "auth";

  if (status === 429) return "rate_limit";

  if (status === 404) return "not_found";

  if (status === 400 || status === 422) return "invalid_request";

  if (status >= 500) return "unavailable";

  return "protocol";
}
