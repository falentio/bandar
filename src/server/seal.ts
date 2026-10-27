const ALGORITHM = "AES-GCM";
const PREFIX = "v1";
const IV_BYTES = 12;

export type Sealer = {
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
};

export async function createSealer(secret: string): Promise<Sealer> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`bandar/provider-key/v1:${secret}`),
  );

  const key = await crypto.subtle.importKey("raw", digest, ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]);

  return {
    async seal(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

      const ciphertext = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        new TextEncoder().encode(plaintext),
      );

      return `${PREFIX}.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
    },
    async open(sealed) {
      const [prefix, iv, ciphertext] = sealed.split(".");

      if (prefix !== PREFIX || iv === undefined || ciphertext === undefined) {
        throw new Error("provider key is not in the sealed format");
      }

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: ALGORITHM, iv: decode(iv) },
          key,
          decode(ciphertext),
        );

        return new TextDecoder().decode(plaintext);
      } catch {
        throw new Error(
          "provider key could not be decrypted; BANDAR_AUTH_SECRET changed since it was saved?",
        );
      }
    },
  };
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, "base64url");
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);

  return copy;
}
