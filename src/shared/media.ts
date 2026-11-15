import type { Normalized, Rejected } from "./messages";

/** The image formats all four egress wires can spell. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

/** An image the gateway read: base64, sniffed, measured. */
export type ImageAsset = {
  readonly mediaType: ImageMediaType;
  readonly data: string;
  readonly bytes: number;
  readonly sha256: string;
};

/** Where an image came from, before the gateway read it. */
export type ImageOrigin =
  | { readonly kind: "inline"; readonly mediaType: string; readonly data: string }
  | { readonly kind: "remote"; readonly url: string };

const DATA_URI = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u;

/** A data URI's origin, or null when the string is not one. */
export function parseDataUri(url: string): ImageOrigin | null {
  const match = DATA_URI.exec(url);
  const mediaType = match?.[1];
  const data = match?.[2];

  if (mediaType === undefined || data === undefined) return null;

  return { kind: "inline", mediaType, data: data.replace(/\s+/gu, "") };
}

/** An image url as a wire spells it: a data URI, or an address the gateway fetches itself. */
export function parseImageUrl(url: string): ImageOrigin | null {
  if (url.startsWith("http://") || url.startsWith("https://")) return { kind: "remote", url };

  return parseDataUri(url);
}

/** The image type a byte prefix names, ignoring what the client or the server called it. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";

  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && asciiAt(bytes, 8, 4) === "WEBP")
    return "image/webp";

  return null;
}

/**
 * An inline origin as an asset: decoded, sniffed, measured. The sniffed type wins over the declared
 * one, because a declared type that lies is a client bug and the bytes are what reaches a model.
 */
export function assetOf(
  origin: Extract<ImageOrigin, { kind: "inline" }>,
  at: string,
): Normalized<ImageAsset> {
  if (!isImageMediaType(origin.mediaType))
    return declined(at, `${origin.mediaType} is not an image type this gateway carries`);

  const bytes = decodeBase64(origin.data);

  if (bytes === null) return declined(at, "the image data is not base64");

  return assetOfBytes(bytes, at);
}

/** Bytes already read, as an asset: the single place every image the gateway carries is measured. */
export function assetOfBytes(bytes: Uint8Array, at: string): Normalized<ImageAsset> {
  if (bytes.length > MAX_IMAGE_BYTES)
    return declined(
      at,
      `the image is ${String(bytes.length)} bytes, over the ${String(MAX_IMAGE_BYTES)} byte limit`,
    );

  const mediaType = sniffImage(bytes);

  if (mediaType === null) return declined(at, "the data is not a png, jpeg, gif, or webp image");

  return {
    ok: true,
    value: {
      mediaType,
      data: encodeBase64(bytes),
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    },
  };
}

export function dataUriOf(asset: ImageAsset): string {
  return `data:${asset.mediaType};base64,${asset.data}`;
}

const BYTES_PER_TOKEN = 200;

const MIN_IMAGE_TOKENS = 85;

const MAX_IMAGE_TOKENS = 1590;

/**
 * A deliberately over-reporting estimate: count_tokens is a budget check, so counting too many is
 * the safe direction.
 */
export function imageTokens(bytes: number): number {
  return Math.min(MAX_IMAGE_TOKENS, Math.max(MIN_IMAGE_TOKENS, Math.ceil(bytes / BYTES_PER_TOKEN)));
}

/** Base64 decoded length, so an estimate never decodes a whole image to count it. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s+/gu, "").replace(/=+$/u, "");

  return Math.floor((clean.length * 3) / 4);
}

/** How a log line names an image it does not keep: small enough to keep every row readable. */
export function imageLabel(data: string): string {
  const bytes = decodeBase64(data);

  if (bytes === null) return `${String(data.length)} base64 characters`;

  return `${String(bytes.length)} bytes, sha256 ${sha256Hex(bytes).slice(0, 8)}`;
}

export function decodeBase64(data: string): Uint8Array | null {
  let binary: string;

  try {
    binary = atob(data.replace(/\s+/gu, ""));
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));

  return btoa(binary);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.slice(at, at + length));
}

function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

function declined(at: string, message: string): Rejected {
  return { ok: false, rejection: { status: 422, param: at, message: `${at}: ${message}` } };
}

const SHA256_K = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1,
  0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3,
  0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86,
  0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13,
  0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a,
  0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

const SHA256_INITIAL = new Uint32Array([
  0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c,
  0x1f_83_d9_ab, 0x5b_e0_cd_19,
]);

/**
 * Digest of the bytes, spelled out because an asset is built in the browser-compiled shared layer,
 * where no synchronous hash exists and building one is async.
 */
export function sha256Hex(bytes: Uint8Array): string {
  const schedule = new Uint32Array(64);
  const digest = new Uint32Array(SHA256_INITIAL);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;

  padded.set(bytes);
  padded[bytes.length] = 0x80;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_00_00_00_00), false);
  view.setUint32(padded.length - 4, bits % 0x1_00_00_00_00, false);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      schedule[index] = view.getUint32(offset + index * 4, false);

    for (let index = 16; index < 64; index += 1) {
      const back2 = schedule[index - 2] ?? 0;
      const back15 = schedule[index - 15] ?? 0;

      schedule[index] =
        (schedule[index - 16] ?? 0) +
        (rotr(back15, 7) ^ rotr(back15, 18) ^ (back15 >>> 3)) +
        (schedule[index - 7] ?? 0) +
        (rotr(back2, 17) ^ rotr(back2, 19) ^ (back2 >>> 10));
    }

    let a = digest[0] ?? 0;
    let b = digest[1] ?? 0;
    let c = digest[2] ?? 0;
    let d = digest[3] ?? 0;
    let e = digest[4] ?? 0;
    let f = digest[5] ?? 0;
    let g = digest[6] ?? 0;
    let h = digest[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const temp1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (SHA256_K[index] ?? 0) +
          (schedule[index] ?? 0)) |
        0;

      const temp2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    digest[0] = ((digest[0] ?? 0) + a) | 0;
    digest[1] = ((digest[1] ?? 0) + b) | 0;
    digest[2] = ((digest[2] ?? 0) + c) | 0;
    digest[3] = ((digest[3] ?? 0) + d) | 0;
    digest[4] = ((digest[4] ?? 0) + e) | 0;
    digest[5] = ((digest[5] ?? 0) + f) | 0;
    digest[6] = ((digest[6] ?? 0) + g) | 0;
    digest[7] = ((digest[7] ?? 0) + h) | 0;
  }

  return [...digest].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotr(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}
