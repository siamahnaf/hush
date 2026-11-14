import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { decrypt, encrypt, HushCryptoError } from "./blob";
import { defaultKdf, deriveKey, KdfParams } from "./kdf";

export interface VaultFile {
  format: 1;
  kdf: KdfParams;
  keyId: string;
  wrappedKey: string;
  previousKey?: string;
  createdAt: string;
  updatedAt: string;
}

//Material: 32 bytes for encryption, 32 bytes for opaque ids
export interface VaultKeys {
  material: Buffer;
  encKey: Buffer;
  idKey: Buffer;
  keyId: string;
  previousMaterial?: Buffer;
  previousEncKey?: Buffer;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase doesn't open this vault.");
    this.name = "WrongPassphraseError";
  }
}

const VAULT_AAD = Buffer.from("hush:vault:v1");
const PREVIOUS_AAD = Buffer.from("hush:vault:previous:v1");
const EMPTY = Buffer.alloc(0);

function hkdf(secret: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, EMPTY, label, 32));
}

export function keysFromMaterial(material: Buffer, previousMaterial?: Buffer): VaultKeys {
  if (material.length !== 64 || (previousMaterial && previousMaterial.length !== 64)) {
    throw new HushCryptoError("The vault key is damaged.");
  }
  return {
    material,
    encKey: hkdf(material.subarray(0, 32), "hush:enc"),
    idKey: hkdf(material.subarray(32), "hush:id"),
    keyId: createHash("sha256").update(material).digest("hex").slice(0, 16),
    previousMaterial,
    previousEncKey: previousMaterial ? hkdf(previousMaterial.subarray(0, 32), "hush:enc") : undefined,
  };
}

export function newKeys(): VaultKeys {
  return keysFromMaterial(randomBytes(64));
}

export function rotateKeys(current: VaultKeys): VaultKeys {
  return keysFromMaterial(Buffer.concat([randomBytes(32), current.material.subarray(32)]), current.material);
}

export function withoutPrevious(keys: VaultKeys): VaultKeys {
  return keysFromMaterial(keys.material);
}

export function candidateKeys(keys: VaultKeys): Buffer[] {
  return keys.previousEncKey ? [keys.encKey, keys.previousEncKey] : [keys.encKey];
}

//Vault
export async function wrapVault(keys: VaultKeys, passphrase: string, createdAt?: string, kdf: KdfParams = defaultKdf()): Promise<VaultFile> {
  const kek = await deriveKey(passphrase, kdf);
  const now = new Date().toISOString();
  return {
    format: 1,
    kdf,
    keyId: keys.keyId,
    wrappedKey: encrypt(kek, keys.material, VAULT_AAD).toString("base64"),
    previousKey: keys.previousMaterial ? encrypt(kek, keys.previousMaterial, PREVIOUS_AAD).toString("base64") : undefined,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

export async function createVault(passphrase: string, kdf?: KdfParams): Promise<{ file: VaultFile; keys: VaultKeys }> {
  const keys = newKeys();
  return { keys, file: await wrapVault(keys, passphrase, undefined, kdf) };
}

export async function unlockVault(file: VaultFile, passphrase: string): Promise<VaultKeys> {
  if (file.format !== 1) throw new HushCryptoError("This vault was made by a newer version of Hush. Update the extension.");
  const kek = await deriveKey(passphrase, file.kdf);
  let material: Buffer;
  try {
    material = decrypt(kek, Buffer.from(file.wrappedKey, "base64"), VAULT_AAD);
  } catch {
    throw new WrongPassphraseError();
  }
  const previous = file.previousKey ? decrypt(kek, Buffer.from(file.previousKey, "base64"), PREVIOUS_AAD) : undefined;
  return keysFromMaterial(material, previous);
}

export function rewrapVault(file: VaultFile, keys: VaultKeys, passphrase: string, kdf?: KdfParams): Promise<VaultFile> {
  return wrapVault(keys, passphrase, file.createdAt, kdf);
}

//Helpers
export function deriveId(idKey: Buffer, kind: string, value: string): string {
  return createHmac("sha256", idKey).update(`${kind}\0${value}`).digest("hex").slice(0, 24);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function serializeKeys(keys: VaultKeys): string {
  return JSON.stringify({ v: 1, m: keys.material.toString("base64"), p: keys.previousMaterial?.toString("base64") });
}

export function parseKeys(raw: string): VaultKeys | undefined {
  try {
    const data = JSON.parse(raw) as { m: string; p?: string };
    return keysFromMaterial(Buffer.from(data.m, "base64"), data.p ? Buffer.from(data.p, "base64") : undefined);
  } catch {
    return undefined;
  }
}
