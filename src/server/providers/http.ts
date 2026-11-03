import * as v from "valibot";
import type { Credential } from "../credential";
import { currentCapture, noteRequest, noteResponse } from "../router/exchange";
import {
  UpstreamError,
  type UpstreamClassifier,
  type UpstreamErrorKind,
  type UpstreamRejection,
} from "./types";

/** Whatever a failure envelope calls itself, under the error object or at the top level. */
const ErrorBodySchema = v.object({
  error: v.optional(
    v.object({
      message: v.optional(v.string()),
      type: v.optional(v.string()),
      code: v.optional(v.nullable(v.string())),
    }),
  ),
  message: v.optional(v.string()),
  code: v.optional(v.nullable(v.string())),
});

/** The vendor's own words for "out of allowance": this is not a rate, and a wait will not fix it. */
const BUDGET_CODES: ReadonlySet<string> = new Set(["budget_exceeded", "insufficient_quota"]);

/** At most one day, matching the cooldown cap the gateway otherwise applies. */
const MAX_HINT_MS = 24 * 60 * 60 * 1000;

const DURATION_PART =
  /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;

type Unit =
  | "d"
  | "day"
  | "days"
  | "h"
  | "hr"
  | "hrs"
  | "hour"
  | "hours"
  | "m"
  | "min"
  | "mins"
  | "minute"
  | "minutes"
  | "s"
  | "sec"
  | "secs"
  | "second"
  | "seconds";

const UNIT_MS: Readonly<Record<Unit, number>> = {
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
};

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
  return post(
    request.url,
    { "content-type": "application/json", ...request.headers },
    request.body,
    request.signal,
  );
}

export async function postForm(request: FormPost): Promise<Response> {
  return post(
    request.url,
    { "content-type": "application/x-www-form-urlencoded", ...request.headers },
    new URLSearchParams(request.form).toString(),
    request.signal,
  );
}

/**
 * Notes the outbound call before it leaves, so a connection that never answers still shows what
 * was attempted. Calls the log cannot see — catalogs, OAuth — run outside a capture and pass
 * straight through.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const capture = currentCapture();

  if (capture !== undefined) noteRequest(capture, url, headers, body);

  const response = await send(url, { method: "POST", headers, body }, signal);

  if (capture === undefined || response.body === null) return response;

  const [forCaller, forCapture] = response.body.tee();

  noteResponse(capture, response, forCapture);

  return new Response(forCaller, response);
}

/**
 * A classifier runs before the status mapping, on a failure and on an OK response both: a wire can
 * report an account state in a 200 body. A failure it does not name stays a status kind.
 */
export async function requireOk(response: Response, classify?: UpstreamClassifier): Promise<void> {
  if (response.ok) {
    if (classify === undefined) return;

    const classified = classify({
      status: response.status,
      body: await headOf(response),
      headers: response.headers,
    });

    if (classified === null) return;

    throw classified;
  }

  const rejection = await rejectionOf(response);

  throw classify?.(rejection) ?? statusOf(rejection);
}

/**
 * The first chunk of a response the caller still has to read. The copy is read once and left
 * alone: cancelling it cancels the branch the caller is still reading, and the stream stalls.
 */
async function headOf(response: Response): Promise<string> {
  const copy = response.clone();

  if (copy.body === null) return "";

  const reader = copy.body.getReader();

  try {
    const { value } = await reader.read();

    reader.releaseLock();

    return value === undefined ? "" : new TextDecoder().decode(value);
  } catch {
    reader.releaseLock();

    return "";
  }
}

async function rejectionOf(response: Response): Promise<UpstreamRejection> {
  const body = await response.text();

  return { status: response.status, body, headers: response.headers };
}

function statusOf(rejection: UpstreamRejection): UpstreamError {
  return new UpstreamError(
    messageOf(rejection.body, rejection.status),
    kindForStatus(rejection.status),
    rejection.status,
    retryAfterOf(rejection.headers),
  );
}

/**
 * A classifier for an envelope that names an exhausted allowance in its body: `error.code`, a bare
 * `code`, or the `error.type` slot a wire reuses for it.
 */
export function budgetOfBody(rejection: UpstreamRejection): UpstreamError | null {
  return isBudgetCode(codeOfBody(rejection.body)) ? budgetExceeded(rejection) : null;
}

/** The vendor said the allowance is gone: it names a kind no wait clears, and when it comes back. */
export function budgetExceeded(rejection: UpstreamRejection): UpstreamError {
  return new UpstreamError(
    messageOf(rejection.body, rejection.status),
    "budget_exceeded",
    rejection.status,
    resetFrom(rejection.body) ?? retryAfterOf(rejection.headers),
  );
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

      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      // An upstream that closes right after its last data line still owes that event.
      if (done) buffer += "\n\n";

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

      if (done || signal.aborted) return;
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

function messageOf(body: string, status: number): string {
  if (body === "") return `upstream returned ${status}`;

  try {
    const parsed = v.safeParse(ErrorBodySchema, JSON.parse(body));

    if (parsed.success) {
      return parsed.output.error?.message ?? parsed.output.message ?? `upstream returned ${status}`;
    }
  } catch {
    return body.slice(0, 300);
  }

  return body.slice(0, 300);
}

/** A code the body calls itself: `code`, or `type` where a wire puts the code there. */
export function codeOfBody(body: string): string | null {
  return parsedBody(body)?.code ?? null;
}

export function messageOfBody(body: string): string | null {
  const parsed = parsedBody(body);

  if (parsed === null) return null;

  return parsed.message ?? null;
}

export function isBudgetCode(code: string | null): boolean {
  return code !== null && BUDGET_CODES.has(code);
}

/** "Resets in 6h 11m" is the vendor's own countdown: it beats a header, which proxies rewrite. */
export function resetFrom(body: string): Date | null {
  const message = messageOfBody(body);

  if (message === null) return null;

  const ms = durationMs(message);

  return clamped(new Date(Date.now() + ms));
}

/** A Retry-After of seconds or an HTTP date, for the vendors that send one instead. */
export function retryAfterOf(headers: Headers): Date | null {
  const value = headers.get("retry-after")?.trim();

  if (value === undefined || value === "") return null;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) return clamped(new Date(Date.now() + seconds * 1000));

  const at = Date.parse(value);

  return Number.isNaN(at) ? null : clamped(new Date(at));
}

function durationMs(message: string): number {
  let total = 0;

  for (const [, amount, unit] of message.matchAll(DURATION_PART)) {
    if (amount === undefined || unit === undefined) continue;

    // SAFETY: DURATION_PART only matches the unit words UNIT_MS is keyed by.
    total += Number(amount) * UNIT_MS[unit.toLowerCase() as Unit];
  }

  return total;
}

function clamped(at: Date): Date | null {
  const ms = at.getTime() - Date.now();

  return ms <= 0 ? null : new Date(Date.now() + Math.min(ms, MAX_HINT_MS));
}

function parsedBody(body: string): { code: string | null; message: string | null } | null {
  try {
    const parsed = v.safeParse(ErrorBodySchema, JSON.parse(body));

    if (!parsed.success) return null;

    return {
      code: parsed.output.error?.code ?? parsed.output.code ?? parsed.output.error?.type ?? null,
      message: parsed.output.error?.message ?? parsed.output.message ?? null,
    };
  } catch {
    return null;
  }
}

function kindForStatus(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return "auth";

  if (status === 402) return "budget_exceeded";

  if (status === 429) return "rate_limit";

  if (status === 404) return "not_found";

  if (status === 400 || status === 422) return "invalid_request";

  if (status >= 500) return "unavailable";

  return "unknown";
}
