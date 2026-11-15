import { lookup } from "node:dns/promises";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { MAX_IMAGE_BYTES, assetOfBytes, type ImageAsset } from "../../shared/media";
import type { Normalized } from "../../shared/messages";

export const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Reads an image the client named by address. It is built on node:http rather than fetch because
 * bun's fetch ignores a dispatcher, and a dispatcher is the only way to pin the address the guard
 * checked. No credential, cookie, or referer travels, and a redirect is never followed.
 */
export async function fetchImage(
  url: string,
  signal: AbortSignal,
): Promise<Normalized<ImageAsset>> {
  const target = targetOf(url);

  if (!target.ok) return target;

  const addresses = await addressesOf(target.value.hostname);

  if (!addresses.ok) return addresses;

  return readImage(url, addresses.value, signal);
}

/**
 * The socket half, for a caller that has already checked the addresses it pins. It is exported so
 * the read can be exercised against a real server without the guard in front of it.
 */
export async function readImage(
  url: string,
  addresses: readonly ResolvedAddress[],
  signal: AbortSignal,
): Promise<Normalized<ImageAsset>> {
  const target = targetOf(url);

  if (!target.ok) return target;

  const bytes = await readBody(target.value, addresses, signal);

  if (!bytes.ok) return bytes;

  return assetOfBytes(bytes.value, "");
}

/** The fetch's own refusal, before a part's path is known: the caller names the part. */
function refused(message: string): Normalized<never> {
  return { ok: false, rejection: { status: 422, param: "", message } };
}

type Target = { readonly url: URL; readonly hostname: string; readonly secure: boolean };

export type ResolvedAddress = { readonly address: string; readonly family: number };

function targetOf(url: string): Normalized<Target> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return refused("the image url is not a url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return refused("the image url is not http or https");

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");

  if (hostname === "") return refused("the image url names no host");

  return { ok: true, value: { url: parsed, hostname, secure: parsed.protocol === "https:" } };
}

/** Every address the name resolves to. One private answer refuses the name whole. */
async function addressesOf(hostname: string): Promise<Normalized<readonly ResolvedAddress[]>> {
  const literal = isIP(hostname);

  if (literal !== 0) {
    if (isPrivate(hostname)) return refused(privateMessage(hostname));

    return { ok: true, value: [{ address: hostname, family: literal }] };
  }

  let resolved: readonly ResolvedAddress[];

  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    return refused(`${hostname} did not resolve`);
  }

  if (resolved.length === 0) return refused(`${hostname} did not resolve`);

  const blocked = resolved.find((entry) => isPrivate(entry.address));

  if (blocked !== undefined) return refused(privateMessage(blocked.address));

  return { ok: true, value: resolved };
}

function privateMessage(address: string): string {
  return `the image url resolves to ${address}, a private address this gateway will not reach`;
}

function readBody(
  target: Target,
  addresses: readonly ResolvedAddress[],
  signal: AbortSignal,
): Promise<Normalized<Uint8Array>> {
  const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0];

  if (pinned === undefined) return Promise.resolve(refused("the image url resolved to no address"));

  return new Promise((resolve) => {
    let settled = false;

    const path = `${target.url.pathname}${target.url.search}`;

    const agent = target.secure
      ? new HttpsAgent({ lookup: pinnedLookup(pinned) })
      : new HttpAgent({ lookup: pinnedLookup(pinned) });

    const options: RequestOptions = {
      host: target.hostname,
      path,
      method: "GET",
      headers: { accept: "image/*" },
      agent,
    };

    if (target.url.port !== "") options.port = Number(target.url.port);

    const request = target.secure
      ? httpsRequest(options, (response) => readResponse(response, finish))
      : httpRequest(options, (response) => readResponse(response, finish));

    const timer = setTimeout(() => {
      finish(refused(`the image did not answer within ${String(IMAGE_FETCH_TIMEOUT_MS)} ms`));
    }, IMAGE_FETCH_TIMEOUT_MS);

    const onAbort = () => finish(refused("the request was aborted"));

    function finish(result: Normalized<Uint8Array>): void {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      request.destroy();
      resolve(result);
    }

    signal.addEventListener("abort", onAbort, { once: true });

    request.on("error", () => finish(refused("the image could not be read")));
    request.end();
  });
}

function readResponse(response: IncomingMessage, finish: (result: Normalized<Uint8Array>) => void) {
  const status = response.statusCode ?? 0;

  if (status >= 300 && status < 400) {
    response.resume();
    finish(refused("the image url answered with a redirect, which this gateway does not follow"));

    return;
  }

  if (status !== 200) {
    response.resume();
    finish(refused(`the image url answered with status ${String(status)}`));

    return;
  }

  if (Number(response.headers["content-length"] ?? "0") > MAX_IMAGE_BYTES) {
    response.resume();
    finish(tooLarge());

    return;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  response.on("data", (chunk: Uint8Array) => {
    if (total + chunk.length > MAX_IMAGE_BYTES) {
      response.destroy();
      finish(tooLarge());

      return;
    }

    total += chunk.length;
    chunks.push(chunk);
  });

  response.on("error", () => finish(refused("the image could not be read")));

  response.on("end", () => finish({ ok: true, value: concat(chunks, total) }));
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

function tooLarge(): Normalized<never> {
  return refused(`the image is over the ${String(MAX_IMAGE_BYTES)} byte limit`);
}

/**
 * Pins the address the guard checked, so a second DNS answer cannot move the connection. Node types
 * this as two overloads and asks which one it wants through the options, so it is dispatched there.
 */
function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  type AnyCallback = (error: null, address: LookupAnswer, family?: number) => void;

  // SAFETY: node types this as one signature per overload, and the branch on options.all is the
  // whole difference between them, so the function answers whichever the caller asked for.
  return ((_hostname: string, options: { readonly all?: boolean }, callback: AnyCallback) => {
    if (options.all === true) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

type LookupAnswer = string | readonly ResolvedAddress[];

/** Loopback, link-local, private, CGNAT, and the v4-mapped IPv6 spelling of each. */
function isPrivate(address: string): boolean {
  const v4 = v4Of(address);

  if (v4 !== null) {
    const [first = 0, second = 0] = v4;

    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }

  const v6 = v6Of(address);

  if (v6 === null) return true;

  const [first = 0, , , , , sixth = 0, seventh = 0, eighth = 0] = v6;

  // A v4-mapped name is the IPv4 rule once more, read off the last two groups.
  if (first === 0 && sixth === 0xff_ff)
    return isPrivate(
      `${String(seventh >> 8)}.${String(seventh & 0xff)}.${String(eighth >> 8)}.${String(eighth & 0xff)}`,
    );

  if (v6.every((group) => group === 0) || address === "::1") return true;

  if ((first & 0xfe_00) === 0xfc_00) return true;

  if ((first & 0xff_c0) === 0xfe_80) return true;

  return false;
}

function v4Of(address: string): readonly number[] | null {
  const parts = address.split(".");

  if (parts.length !== 4) return null;

  const octets = parts.map(Number);

  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/** The 16-bit groups of an IPv6 address, with a v4-mapped tail read as its own four octets. */
function v6Of(address: string): readonly number[] | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);

  if (mapped?.[1] !== undefined) return v4Of(mapped[1]);

  if (!address.includes(":")) return null;

  const [head = "", tail = ""] = address.split("::");

  if (!address.includes("::")) {
    const groups = address.split(":");

    return groups.length === 8 ? groups.map((group) => Number.parseInt(group, 16)) : null;
  }

  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const fill = 8 - headGroups.length - tailGroups.length;

  if (fill < 0) return null;

  const groups = [...headGroups, ...Array.from({ length: fill }, () => "0"), ...tailGroups];

  return groups.map((group) => Number.parseInt(group === "" ? "0" : group, 16));
}
