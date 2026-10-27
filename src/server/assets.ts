import { extname } from "node:path";

export type EmbeddedClientFile = { readonly url: string; readonly path: string };

export type Asset = {
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: Blob;
};

export type ClientBundle =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly index: Asset; readonly byPath: ReadonlyMap<string, Asset> };

const INDEX_PATH = "/index.html";
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createClientBundle(files: readonly EmbeddedClientFile[]): ClientBundle {
  const byPath = new Map<string, Asset>();
  for (const file of files) {
    byPath.set(file.url, {
      contentType: contentTypeFor(file.url),
      cacheControl: file.url.startsWith("/assets/") ? IMMUTABLE : NO_CACHE,
      body: Bun.file(file.path),
    });
  }

  const index = byPath.get(INDEX_PATH);
  if (!index) return { kind: "empty" };

  return { kind: "ready", index, byPath };
}

export function serveStatic(request: Request, bundle: ClientBundle): Response {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return text(405, "method not allowed");
  if (bundle.kind === "empty") {
    return text(503, "no client is embedded in this binary. Run `bun run build`.");
  }

  const { pathname } = new URL(request.url);

  const asset = bundle.byPath.get(pathname);
  if (asset) return withBody(asset, method);

  if (pathname.startsWith("/assets/")) return text(404, "not found");

  if (extname(pathname) === "") return withBody(bundle.index, method);

  return text(404, "not found");
}

function withBody(asset: Asset, method: string): Response {
  const headers = {
    "content-type": asset.contentType,
    "content-length": String(asset.body.size),
    "cache-control": asset.cacheControl,
  };
  return new Response(method === "HEAD" ? null : asset.body, { headers });
}

function contentTypeFor(url: string): string {
  return CONTENT_TYPES[extname(url).toLowerCase()] ?? "application/octet-stream";
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_CACHE },
  });
}
