import { decryptAny, encrypt, HushCryptoError } from "./blob";

export interface FileHeader {
  v: 1;
  path: string;
  device: string;
  savedAt: string;
}

export const fileAad = (projectId: string, fileId: string) => Buffer.from(`hush:file:${projectId}:${fileId}`);
export const infoAad = (projectId: string) => Buffer.from(`hush:info:${projectId}`);

//Plaintext: header JSON line, then raw file bytes
export function sealFile(key: Buffer, aad: Buffer, header: FileHeader, content: Buffer): Buffer {
  const head = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return encrypt(key, Buffer.concat([head, content]), aad);
}

export function openFile(keys: Buffer[], aad: Buffer, blob: Buffer): { header: FileHeader; content: Buffer } {
  const plain = decryptAny(keys, blob, aad);
  const newline = plain.indexOf(0x0a);
  if (newline < 0) throw new HushCryptoError("This backup is damaged.");
  const header = JSON.parse(plain.subarray(0, newline).toString("utf8")) as FileHeader;
  return { header, content: plain.subarray(newline + 1) };
}

export function sealJson(key: Buffer, aad: Buffer, value: unknown): Buffer {
  return encrypt(key, Buffer.from(JSON.stringify(value), "utf8"), aad);
}

export function openJson<T>(keys: Buffer[], aad: Buffer, blob: Buffer): T {
  return JSON.parse(decryptAny(keys, blob, aad).toString("utf8")) as T;
}
