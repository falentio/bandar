import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TARGET_DIR = join(ROOT, "vendor/duckdb");
const GENERATED = join(ROOT, "src/server/generated/duck-lib.ts");
const require = createRequire(import.meta.url);

const LIBRARY =
  process.platform === "darwin"
    ? "libduckdb.dylib"
    : process.platform === "win32"
      ? "duckdb.dll"
      : "libduckdb.so";

const SUFFIXES = [
  `${process.platform}-${process.arch}`,
  `${process.platform}-${process.arch}-musl`,
] as const;

export function fetchDuckDb(): string {
  const override = Bun.env.BANDAR_DUCKDB_LIB;

  if (override !== undefined) return copy(override);

  for (const suffix of SUFFIXES) {
    const packageJson = tryResolve(`@duckdb/node-bindings-${suffix}/package.json`);

    if (packageJson === null) continue;

    const candidate = join(dirname(packageJson), LIBRARY);

    if (existsSync(candidate)) return copy(candidate);
  }

  throw new Error(
    `no DuckDB library for ${process.platform}-${process.arch}. ` +
      "Install @duckdb/node-bindings or set BANDAR_DUCKDB_LIB to a libduckdb shared library.",
  );
}

function copy(source: string): string {
  const target = join(TARGET_DIR, LIBRARY);

  if (existsSync(target) && statSync(target).size === statSync(source).size) {
    console.log(`duckdb: ${target.slice(ROOT.length + 1)} is current`);
    writeLoader(target);

    return target;
  }

  mkdirSync(TARGET_DIR, { recursive: true });
  copyFileSync(source, target);
  console.log(`duckdb: copied ${source} -> ${target.slice(ROOT.length + 1)}`);
  writeLoader(target);

  return target;
}

function writeLoader(library: string): void {
  const specifier = relative(dirname(GENERATED), library).split(sep).join("/");

  const contents =
    `import library from ${JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`)} with { type: "file" };\n\n` +
    "export default library;\n";

  mkdirSync(dirname(GENERATED), { recursive: true });

  if (existsSync(GENERATED) && readFileSync(GENERATED, "utf8") === contents) return;

  writeFileSync(GENERATED, contents);
}

function tryResolve(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

if (import.meta.main) fetchDuckDb();
