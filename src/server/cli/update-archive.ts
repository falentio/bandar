export type ArchiveFormat = "tar.gz" | "tar.zst";

export type Unpacked =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "failed"; readonly reason: string };

const MEMBER = "bandar";

export function archiveFormatOf(name: string): ArchiveFormat | null {
  if (name.endsWith(".tar.gz")) return "tar.gz";

  if (name.endsWith(".tar.zst")) return "tar.zst";

  return null;
}

export function toolInstalled(name: string): boolean {
  return Bun.which(name) !== null;
}

export async function unpackArchive(
  format: ArchiveFormat,
  published: Uint8Array,
): Promise<Unpacked> {
  try {
    const decompressor = Bun.spawn(decompressorOf(format), {
      stdin: published,
      stdout: "pipe",
      stderr: "pipe",
    });

    const tar = Bun.spawn(["tar", "-x", "-O", "-f", "-", MEMBER], {
      stdin: decompressor.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Both pipes drain while the processes run: a full pipe buffer would block the child forever.
    const tarError = new Response(tar.stderr).text();
    const decompressorError = new Response(decompressor.stderr).text();
    const bytes = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
    const [tarExit, decompressorExit] = await Promise.all([tar.exited, decompressor.exited]);

    if (tarExit !== 0)
      return {
        kind: "failed",
        reason: lastLine(await tarError) ?? `tar exited ${String(tarExit)}`,
      };

    if (decompressorExit !== 0)
      return {
        kind: "failed",
        reason: lastLine(await decompressorError) ?? `${format} decompression failed`,
      };

    if (bytes.length === 0) return { kind: "failed", reason: `the archive holds no ${MEMBER}` };

    return { kind: "bytes", bytes };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the archive could not be unpacked",
    };
  }
}

function decompressorOf(format: ArchiveFormat): string[] {
  switch (format) {
    case "tar.gz":
      return ["gzip", "-d", "-c"];
    case "tar.zst":
      return ["zstd", "-d", "-c"];
  }
}

function lastLine(text: string): string | null {
  let last: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line !== "") last = line;
  }

  return last;
}
