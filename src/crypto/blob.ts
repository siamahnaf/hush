import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

//Format: HUSH | version | iv[12] | ciphertext | tag[16]
const MAGIC = Buffer.from("HUSH", "ascii");
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1;

export class HushCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HushCryptoError";
  }
}

export function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]);
}

export function decrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new HushCryptoError("This isn't a Hush backup.");
  }
  if (blob[MAGIC.length] !== VERSION) {
    throw new HushCryptoError("This backup was made by a newer version of Hush. Update the extension.");
  }
  const iv = blob.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const body = blob.subarray(HEADER_LENGTH + IV_LENGTH, blob.length - TAG_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new HushCryptoError("This backup can't be decrypted with your vault key.");
  }
}

export function decryptAny(keys: Buffer[], blob: Buffer, aad: Buffer): Buffer {
  let last: unknown;
  for (const key of keys) {
    try {
      return decrypt(key, blob, aad);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new HushCryptoError("This backup can't be decrypted with your vault key.");
}
