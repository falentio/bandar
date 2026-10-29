import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "./npm";

const packages = value("--packages");
const tarballs = value("--tarballs");
const portFile = value("--port-file");

type Entry = {
  readonly name: string;
  readonly version: string;
  readonly manifest: Manifest;
  readonly tarball: string;
};

const entries = new Map<string, Entry>();

for (const directory of readdirSync(packages, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;

  const manifest = JSON.parse(readFileSync(join(packages, directory.name, "package.json"), "utf8")) as Manifest;

  entries.set(manifest.name, {
    name: manifest.name,
    version: manifest.version,
    manifest,
    tarball: join(tarballs, `${manifest.name}-${manifest.version}.tgz`),
  });
}

if (entries.size === 0) {
  console.error(`registry-stub: ${packages} holds no staged package`);
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${server.port}`;

    if (url.pathname === "/-/npm/v1/security/advisories/bulk") return Response.json({});

    const tarball = /^\/(?<name>[^/]+)\/-\/(?<file>[^/]+)\.tgz$/u.exec(url.pathname);

    if (tarball?.groups !== undefined) {
      const entry = entries.get(tarball.groups.name);

      if (entry === undefined || `${entry.name}-${entry.version}` !== tarball.groups.file) {
        return new Response(null, { status: 404 });
      }

      return new Response(Bun.file(entry.tarball));
    }

    const entry = entries.get(decodeURIComponent(url.pathname.replace(/^\//u, "")));

    if (entry === undefined || !existsSync(entry.tarball)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const bytes = readFileSync(entry.tarball);

    return Response.json({
      name: entry.name,
      "dist-tags": { latest: entry.version },
      versions: {
        [entry.version]: {
          ...entry.manifest,
          dist: {
            tarball: `${origin}/${entry.name}/-/${entry.name}-${entry.version}.tgz`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          },
        },
      },
    });
  },
});

writeFileSync(portFile, `${server.port}\n`);

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  const found = index === -1 ? undefined : process.argv[index + 1];

  if (found === undefined) {
    console.error(`registry-stub: ${flag} needs a value`);
    process.exit(1);
  }

  return found;
}
