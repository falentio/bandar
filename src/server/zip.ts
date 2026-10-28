export type ZipMethod = "stored" | "deflate";

export type ZipEntry = {
  readonly name: string;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly method: ZipMethod;
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;

const ZIP_VERSION = 20;
const MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FILE_MODE = 0o100644;

const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
const MAX_SIZE = 0xffffffff;

type Prepared = {
  readonly name: Uint8Array;
  readonly payload: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly size: number;
};

/**
 * Build a zip archive in memory: local file headers and payloads, then the central
 * directory, then the end-of-central-directory record. No zip64, so a member of
 * 4 GiB or more is refused rather than silently truncated.
 */
export function createZip(entries: readonly ZipEntry[], modifiedAt: Date): Uint8Array {
  const { date, time } = dosTimestamp(modifiedAt);
  const prepared = entries.map((entry) => prepare(entry));

  let localSize = 0;
  let directorySize = 0;

  for (const entry of prepared) {
    localSize += LOCAL_SIZE + entry.name.byteLength + entry.payload.byteLength;
    directorySize += CENTRAL_SIZE + entry.name.byteLength;
  }

  const bytes = new Uint8Array(localSize + directorySize + END_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let local = 0;
  let directory = localSize;

  for (const entry of prepared) {
    const offset = local;

    view.setUint32(local, LOCAL_HEADER, true);
    view.setUint16(local + 4, ZIP_VERSION, true);
    view.setUint16(local + 6, 0, true);
    view.setUint16(local + 8, entry.method, true);
    view.setUint16(local + 10, time, true);
    view.setUint16(local + 12, date, true);
    view.setUint32(local + 14, entry.crc, true);
    view.setUint32(local + 18, entry.payload.byteLength, true);
    view.setUint32(local + 22, entry.size, true);
    view.setUint16(local + 26, entry.name.byteLength, true);
    view.setUint16(local + 28, 0, true);
    bytes.set(entry.name, local + LOCAL_SIZE);
    bytes.set(entry.payload, local + LOCAL_SIZE + entry.name.byteLength);
    local += LOCAL_SIZE + entry.name.byteLength + entry.payload.byteLength;

    view.setUint32(directory, CENTRAL_HEADER, true);
    view.setUint16(directory + 4, MADE_BY_UNIX, true);
    view.setUint16(directory + 6, ZIP_VERSION, true);
    view.setUint16(directory + 8, 0, true);
    view.setUint16(directory + 10, entry.method, true);
    view.setUint16(directory + 12, time, true);
    view.setUint16(directory + 14, date, true);
    view.setUint32(directory + 16, entry.crc, true);
    view.setUint32(directory + 20, entry.payload.byteLength, true);
    view.setUint32(directory + 24, entry.size, true);
    view.setUint16(directory + 28, entry.name.byteLength, true);
    view.setUint16(directory + 30, 0, true);
    view.setUint16(directory + 32, 0, true);
    view.setUint16(directory + 34, 0, true);
    view.setUint16(directory + 36, 0, true);
    view.setUint32(directory + 38, FILE_MODE << 16, true);
    view.setUint32(directory + 42, offset, true);
    bytes.set(entry.name, directory + CENTRAL_SIZE);
    directory += CENTRAL_SIZE + entry.name.byteLength;
  }

  view.setUint32(directory, END_RECORD, true);
  view.setUint16(directory + 4, 0, true);
  view.setUint16(directory + 6, 0, true);
  view.setUint16(directory + 8, prepared.length, true);
  view.setUint16(directory + 10, prepared.length, true);
  view.setUint32(directory + 12, directorySize, true);
  view.setUint32(directory + 16, localSize, true);
  view.setUint16(directory + 20, 0, true);

  return bytes;
}

function prepare(entry: ZipEntry): Prepared {
  if (entry.data.byteLength > MAX_SIZE)
    throw new Error(
      `${entry.name} is ${String(entry.data.byteLength)} bytes; a zip member stops at 4 GiB`,
    );

  const deflated = entry.method === "deflate";

  return {
    name: new TextEncoder().encode(entry.name),
    payload: deflated ? Bun.deflateSync(entry.data) : entry.data,
    method: deflated ? METHOD_DEFLATE : METHOD_STORED,
    crc: Bun.hash.crc32(entry.data) >>> 0,
    size: entry.data.byteLength,
  };
}

function dosTimestamp(at: Date) {
  const year = Math.max(at.getUTCFullYear(), 1980);
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);

  return { date, time };
}
