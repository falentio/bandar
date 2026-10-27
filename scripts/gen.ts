import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DRIZZLE_DIR = join(ROOT, "drizzle");
const JOURNAL = join(DRIZZLE_DIR, "meta/_journal.json");
const CLIENT_DIR = join(ROOT, "dist/client");
const STAGING_DIR = join(ROOT, ".build/embed");
const GENERATED_DIR = join(ROOT, "src/server/generated");

export type GeneratedFile = { readonly url: string; readonly path: string };

type Journal = { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };

export type GenReport = {
  readonly assets: number;
  readonly migrations: number;
  readonly changed: readonly string[];
};

export function generate(options: { readonly strict?: boolean } = {}): GenReport {
  const strict = options.strict ?? false;
  const changed: string[] = [];

  const migrations = readMigrations(strict);
  writeGenerated(join(GENERATED_DIR, "migrations.ts"), renderMigrations(migrations), changed);

  const files = readClientFiles(strict);
  rmSync(STAGING_DIR, { recursive: true, force: true });
  writeGenerated(join(GENERATED_DIR, "client-assets.ts"), renderClientFiles(files), changed);

  console.log(`gen: ${files.length} assets, ${migrations.length} migrations`);

  return { assets: files.length, migrations: migrations.length, changed };
}

type MigrationSource = { readonly tag: string; readonly file: string };

function readMigrations(strict: boolean): readonly MigrationSource[] {
  if (!existsSync(JOURNAL)) {
    if (strict)
      throw new Error(`gen: missing ${fromRoot(JOURNAL)}; run \`bunx drizzle-kit generate\` first`);
    console.error(`gen: no ${fromRoot(JOURNAL)} yet; emitting an empty migration list`);

    return [];
  }

  // SAFETY: drizzle-kit wrote this journal; only entries[].idx and entries[].tag are read.
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as Journal;
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  return entries.map((entry) => {
    const file = join(DRIZZLE_DIR, `${entry.tag}.sql`);

    if (!existsSync(file)) {
      throw new Error(
        `gen: ${fromRoot(JOURNAL)} names ${entry.tag}, but ${fromRoot(file)} is missing`,
      );
    }

    return { tag: entry.tag, file };
  });
}

function readClientFiles(strict: boolean): readonly GeneratedFile[] {
  if (!existsSync(join(CLIENT_DIR, "index.html"))) {
    if (strict) throw new Error("gen: no dist/client/index.html; run `bun run build:client` first");
    console.error("gen: no dist/client build; emitting an empty client bundle");

    return [];
  }

  const files = walk(CLIENT_DIR).map((rel) => ({ url: `/${rel}`, path: join(CLIENT_DIR, rel) }));

  return files.sort((a, b) => a.url.localeCompare(b.url));
}

function walk(dir: string): readonly string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    out.push(
      posix.join(
        entry.parentPath
          .slice(dir.length + 1)
          .split(sep)
          .join("/"),
        entry.name,
      ),
    );
  }

  return out;
}

function renderMigrations(migrations: readonly MigrationSource[]): string {
  const head = 'import type { Migration } from "../db/migrate";\n';

  if (migrations.length === 0)
    return `${head}\nexport const migrations: readonly Migration[] = [];\n`;

  const imports = migrations.map(
    (m, i) => `import m${i} from ${quote(importSpecifier(m.file))} with { type: "text" };`,
  );

  const rows = migrations.map((m, i) => `  { tag: ${quote(m.tag)}, sql: m${i} },`);

  return `${head}\n${imports.join("\n")}\n\nexport const migrations = [\n${rows.join("\n")}\n] satisfies readonly Migration[];\n`;
}

function renderClientFiles(files: readonly GeneratedFile[]): string {
  const head = 'import type { EmbeddedClientFile } from "../assets";\n';

  if (files.length === 0)
    return `${head}\nexport const clientFiles: readonly EmbeddedClientFile[] = [];\n`;

  mkdirSync(STAGING_DIR, { recursive: true });

  const staged = files.map((file) => {
    const rel = file.url.slice(1);
    const embedded = join(STAGING_DIR, `${rel}.embed`);
    mkdirSync(dirname(embedded), { recursive: true });
    copyFileSync(file.path, embedded);

    return { url: file.url, embedded };
  });

  const imports = staged.map(
    (file, i) =>
      `import a${i} from ${quote(importSpecifier(file.embedded))} with { type: "file" };`,
  );

  const rows = staged.map((file, i) => `  { url: ${quote(file.url)}, path: a${i} },`);

  return `${head}\n${imports.join("\n")}\n\nexport const clientFiles = [\n${rows.join("\n")}\n] satisfies readonly EmbeddedClientFile[];\n`;
}

function writeGenerated(target: string, contents: string, changed: string[]): void {
  if (existsSync(target) && readFileSync(target, "utf8") === contents) return;

  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, target);
  changed.push(fromRoot(target));
}

function fromRoot(path: string): string {
  return join(path.slice(ROOT.length + 1))
    .split(sep)
    .join("/");
}

function importSpecifier(path: string): string {
  const spec = relative(GENERATED_DIR, path).split(sep).join("/");

  return spec.startsWith(".") ? spec : `./${spec}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

if (import.meta.main) {
  generate({ strict: process.argv.includes("--strict") });
}
