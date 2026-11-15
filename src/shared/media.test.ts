import { describe, expect, test } from "vite-plus/test";
import {
  MAX_IMAGE_BYTES,
  assetOf,
  assetOfBytes,
  base64Bytes,
  dataUriOf,
  decodeBase64,
  imageLabel,
  imageTokens,
  parseDataUri,
  parseImageUrl,
  sniffImage,
} from "./media";

function base64(bytes: readonly number[]): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

/** A reference digest, so the carried one is checked against something else that computes it. */
async function sha256(bytes: readonly number[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOf(asset: { readonly data: string }): Uint8Array {
  const decoded = decodeBase64(asset.data);

  if (decoded === null) throw new Error("an asset's own data did not decode");

  return decoded;
}

/** A real 1x1 transparent png, so the sniff and the round trip run over bytes that decode. */
const PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];

const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00];

const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
];

const HTML = [...new TextEncoder().encode("<html><body>not an image</body></html>")];

describe("sniffImage", () => {
  test("names each of the four types from its magic bytes", () => {
    expect(sniffImage(new Uint8Array(PNG))).toBe("image/png");
    expect(sniffImage(new Uint8Array(JPEG))).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array(GIF))).toBe("image/gif");
    expect(sniffImage(new Uint8Array(WEBP))).toBe("image/webp");
  });

  test("names nothing for a payload that is not an image", () => {
    expect(sniffImage(new Uint8Array(HTML))).toBeNull();
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });

  test("does not take a RIFF container's word for it without WEBP", () => {
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

describe("parseDataUri", () => {
  test("reads the declared type and strips whitespace from the payload", () => {
    expect(parseDataUri("data:image/png;base64," + base64(PNG))).toEqual({
      kind: "inline",
      mediaType: "image/png",
      data: base64(PNG),
    });
    expect(parseDataUri("data:image/png;base64," + "iVBO\nRw0K")).toEqual({
      kind: "inline",
      mediaType: "image/png",
      data: "iVBORw0K",
    });
  });

  test("names nothing for a string that is not a base64 data uri", () => {
    expect(parseDataUri("https://example.com/a.png")).toBeNull();
    expect(parseDataUri("data:image/png,plain")).toBeNull();
    expect(parseDataUri("data:image/png;base64,")).toBeNull();
  });
});

describe("parseImageUrl", () => {
  test("takes a data uri and an http address, and nothing else", () => {
    expect(parseImageUrl("data:image/png;base64," + base64(PNG))).toMatchObject({
      kind: "inline",
    });
    expect(parseImageUrl("https://example.com/a.png")).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
    });
    expect(parseImageUrl("file:///etc/passwd")).toBeNull();
    expect(parseImageUrl("ftp://example.com/a.png")).toBeNull();
  });
});

describe("assetOf", () => {
  test("re-labels a declared type that lies to what the bytes are", () => {
    const asset = assetOf(
      { kind: "inline", mediaType: "image/jpeg", data: base64(GIF) },
      "messages.0.content.0",
    );

    expect(asset.ok && asset.value.mediaType).toBe("image/gif");
  });

  test("measures the decoded bytes and keeps them in one canonical spelling", async () => {
    const asset = assetOf(
      { kind: "inline", mediaType: "image/png", data: base64(PNG) },
      "messages.0.content.0",
    );

    expect(asset.ok).toBe(true);

    if (!asset.ok) return;

    expect(asset.value.bytes).toBe(PNG.length);
    expect(bytesOf(asset.value)).toEqual(new Uint8Array(PNG));
    expect(asset.value.sha256).toBe(await sha256(PNG));
  });

  test("refuses a payload that is not an image, at the part's path", () => {
    expect(
      assetOf(
        { kind: "inline", mediaType: "image/png", data: base64(HTML) },
        "messages.0.content.0",
      ),
    ).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "messages.0.content.0",
        message: "messages.0.content.0: the data is not a png, jpeg, gif, or webp image",
      },
    });
  });

  test("refuses a declared type outside the carried set", () => {
    expect(
      assetOf(
        { kind: "inline", mediaType: "image/tiff", data: base64(PNG) },
        "messages.0.content.0",
      ),
    ).toMatchObject({
      ok: false,
      rejection: {
        param: "messages.0.content.0",
        message: "messages.0.content.0: image/tiff is not an image type this gateway carries",
      },
    });
  });

  test("refuses data that is not base64", () => {
    expect(
      assetOf(
        { kind: "inline", mediaType: "image/png", data: "!!!!!!!!!!!!!!!!" },
        "messages.0.content.0",
      ),
    ).toMatchObject({
      ok: false,
      rejection: { message: "messages.0.content.0: the image data is not base64" },
    });
  });
});

describe("assetOfBytes", () => {
  test("refuses bytes over the cap before it sniffs them", () => {
    expect(assetOfBytes(new Uint8Array(MAX_IMAGE_BYTES + 1), "messages.0.content.0")).toMatchObject(
      {
        ok: false,
        rejection: {
          param: "messages.0.content.0",
          message: "messages.0.content.0: the image is 5242881 bytes, over the 5242880 byte limit",
        },
      },
    );
  });
});

describe("dataUriOf", () => {
  test("round-trips through parseDataUri", () => {
    const asset = assetOfBytes(new Uint8Array(PNG), "messages.0.content.0");

    if (!asset.ok) throw new Error("the png was not read as an asset");

    const uri = dataUriOf(asset.value);

    expect(uri).toBe("data:image/png;base64," + base64(PNG));
    expect(parseDataUri(uri)).toEqual({
      kind: "inline",
      mediaType: "image/png",
      data: base64(PNG),
    });
  });
});

describe("base64Bytes", () => {
  test("reads the decoded length without decoding the image", () => {
    expect(base64Bytes(base64(PNG))).toBe(PNG.length);
    expect(base64Bytes(base64(JPEG))).toBe(JPEG.length);
    expect(base64Bytes(base64(GIF))).toBe(GIF.length);
  });
});

describe("imageTokens", () => {
  test("clamps at both ends of the ladder", () => {
    expect(imageTokens(0)).toBe(85);
    expect(imageTokens(200)).toBe(85);
    expect(imageTokens(200 * 86)).toBe(86);
    expect(imageTokens(200 * 1589)).toBe(1589);
    expect(imageTokens(200 * 1590)).toBe(1590);
    expect(imageTokens(50 * 1024 * 1024)).toBe(1590);
  });
});

describe("imageLabel", () => {
  test("names the size and the digest prefix without keeping the bytes", async () => {
    expect(imageLabel(base64(PNG))).toBe(
      PNG.length + " bytes, sha256 " + (await sha256(PNG)).slice(0, 8),
    );
  });
});
