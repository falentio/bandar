import { inflateRawSync } from "node:zlib";
import { describe, expect, test } from "vite-plus/test";
import { createZip, type ZipEntry } from "./zip";

const AT = new Date("2026-01-02T03:04:05Z");
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

type Parsed = {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
};

/** Walk the local headers, then the central directory, and check that they agree. */
function parse(bytes: Uint8Array): readonly Parsed[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;

  expect(view.getUint32(end, true)).toBe(0x06054b50);

  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const entries: Parsed[] = [];
  let local = 0;
  let directory = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(local, true)).toBe(0x04034b50);

    const method = view.getUint16(local + 8, true);
    const crc = view.getUint32(local + 14, true);
    const compressedSize = view.getUint32(local + 18, true);
    const size = view.getUint32(local + 22, true);
    const nameLength = view.getUint16(local + 26, true);
    const extraLength = view.getUint16(local + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + nameLength));
    const start = local + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + compressedSize);
    const data = method === METHOD_DEFLATE ? new Uint8Array(inflateRawSync(payload)) : payload;

    expect(data.byteLength).toBe(size);
    expect(Bun.hash.crc32(data) >>> 0).toBe(crc);

    expect(view.getUint32(directory, true)).toBe(0x02014b50);

    const centralNameLength = view.getUint16(directory + 28, true);

    const centralName = new TextDecoder().decode(
      bytes.subarray(directory + 46, directory + 46 + centralNameLength),
    );

    expect(centralName).toBe(name);
    expect(view.getUint16(directory + 10, true)).toBe(method);
    expect(view.getUint32(directory + 16, true)).toBe(crc);
    expect(view.getUint32(directory + 20, true)).toBe(compressedSize);
    expect(view.getUint32(directory + 24, true)).toBe(size);
    expect(view.getUint32(directory + 42, true)).toBe(local);

    entries.push({ name, data, method, compressedSize, size });

    local += 30 + nameLength + extraLength + compressedSize;
    directory +=
      46 +
      centralNameLength +
      view.getUint16(directory + 30, true) +
      view.getUint16(directory + 32, true);
  }

  expect(local).toBe(directoryOffset);

  return entries;
}

describe("createZip", () => {
  test("an empty archive is one end-of-central-directory record", () => {
    const bytes = createZip([], AT);

    expect(bytes.byteLength).toBe(22);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x06054b50);
    expect(parse(bytes)).toEqual([]);
  });

  test("stores an entry verbatim", () => {
    const data = new TextEncoder().encode('{"version":"0.1.0"}\n');
    const entries = parse(createZip([{ name: "manifest.json", data, method: "stored" }], AT));
    const entry = entries[0];

    expect(entries).toHaveLength(1);
    expect(entry?.name).toBe("manifest.json");
    expect(entry?.method).toBe(METHOD_STORED);
    expect(entry?.compressedSize).toBe(data.byteLength);
    expect(entry?.data).toEqual(data);
  });

  test("deflates an entry through Bun.deflateSync", () => {
    const data = new TextEncoder().encode("bandar ".repeat(500));
    const entries = parse(createZip([{ name: "bandar.db", data, method: "deflate" }], AT));
    const entry = entries[0];

    expect(entry?.method).toBe(METHOD_DEFLATE);
    expect(entry?.size).toBe(data.byteLength);
    expect(entry?.compressedSize).toBeLessThan(data.byteLength);
    expect(entry?.data).toEqual(data);
  });

  test("keeps the entry order in both the local headers and the directory", () => {
    const entry = (name: string): ZipEntry => ({
      name,
      data: new TextEncoder().encode(name),
      method: "deflate",
    });

    const entries = parse(
      createZip([entry("bandar.db"), entry("bandar.duckdb"), entry("manifest.json")], AT),
    );

    expect(entries.map((parsed) => parsed.name)).toEqual([
      "bandar.db",
      "bandar.duckdb",
      "manifest.json",
    ]);
  });

  test("records the modification time in UTC", () => {
    const bytes = createZip([{ name: "a", data: new Uint8Array(0), method: "stored" }], AT);
    const view = new DataView(bytes.buffer);

    expect(view.getUint16(10, true)).toBe((3 << 11) | (4 << 5) | 2);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (1 << 5) | 2);
  });
});
