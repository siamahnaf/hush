import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, decryptAny, encrypt } from "../src/crypto/blob";
import { fileAad, openFile, sealFile } from "../src/crypto/envelope";
import { KdfParams } from "../src/crypto/kdf";
import { candidateKeys, createVault, deriveId, parseKeys, rewrapVault, rotateKeys, serializeKeys, unlockVault, WrongPassphraseError, wrapVault } from "../src/crypto/vault";

const fastKdf = (): KdfParams => ({ alg: "scrypt", N: 2 ** 10, r: 8, p: 1, salt: randomBytes(16).toString("base64") });
const aad = Buffer.from("hush:test");

describe("blob", () => {
  it("round-trips", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("API_KEY=secret\n");
    expect(decrypt(key, encrypt(key, plain, aad), aad).equals(plain)).toBe(true);
  });

  it("uses a fresh IV for every encryption", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("same");
    expect(encrypt(key, plain, aad).equals(encrypt(key, plain, aad))).toBe(false);
  });

  it("rejects tampering, wrong keys and wrong AAD", () => {
    const key = randomBytes(32);
    const blob = encrypt(key, Buffer.from("A=1"), aad);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 20] ^= 1;
    expect(() => decrypt(key, tampered, aad)).toThrow();
    expect(() => decrypt(randomBytes(32), blob, aad)).toThrow();
    expect(() => decrypt(key, blob, Buffer.from("other"))).toThrow();
  });

  it("tries every candidate key", () => {
    const oldKey = randomBytes(32);
    const blob = encrypt(oldKey, Buffer.from("A=1"), aad);
    expect(decryptAny([randomBytes(32), oldKey], blob, aad).toString()).toBe("A=1");
  });
});

describe("envelope", () => {
  it("keeps the header and raw bytes", () => {
    const key = randomBytes(32);
    const content = Buffer.from("A=1\nB=line\n");
    const header = { v: 1 as const, path: "api/.env", device: "test", savedAt: new Date().toISOString() };
    const blob = sealFile(key, fileAad("p", "f"), header, content);
    const opened = openFile([key], fileAad("p", "f"), blob);
    expect(opened.header.path).toBe("api/.env");
    expect(opened.content.equals(content)).toBe(true);
    expect(() => openFile([key], fileAad("p", "other"), blob)).toThrow();
  });
});

describe("vault", () => {
  it("unlocks with the right passphrase only", async () => {
    const { file, keys } = await createVault("correct horse battery", fastKdf());
    const unlocked = await unlockVault(file, "correct horse battery");
    expect(unlocked.keyId).toBe(keys.keyId);
    expect(unlocked.encKey.equals(keys.encKey)).toBe(true);
    await expect(unlockVault(file, "wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("changes the passphrase without changing the key", async () => {
    const { file, keys } = await createVault("first passphrase", fastKdf());
    const rewrapped = await rewrapVault(file, keys, "second passphrase", fastKdf());
    expect((await unlockVault(rewrapped, "second passphrase")).keyId).toBe(keys.keyId);
    await expect(unlockVault(rewrapped, "first passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("rotates the encryption key but keeps ids stable", async () => {
    const { keys } = await createVault("rotate me please", fastKdf());
    const rotated = rotateKeys(keys);
    expect(rotated.keyId).not.toBe(keys.keyId);
    expect(rotated.encKey.equals(keys.encKey)).toBe(false);
    expect(deriveId(rotated.idKey, "project", "github.com/acme/app")).toBe(deriveId(keys.idKey, "project", "github.com/acme/app"));

    const oldBlob = encrypt(keys.encKey, Buffer.from("A=1"), aad);
    expect(decryptAny(candidateKeys(rotated), oldBlob, aad).toString()).toBe("A=1");

    const file = await wrapVault(rotated, "rotate me please", undefined, fastKdf());
    const unlocked = await unlockVault(file, "rotate me please");
    expect(unlocked.previousEncKey?.equals(keys.encKey)).toBe(true);
  });

  it("serializes keys for the keychain", async () => {
    const { keys } = await createVault("serialize this one", fastKdf());
    const parsed = parseKeys(serializeKeys(rotateKeys(keys)));
    expect(parsed?.previousEncKey?.equals(keys.encKey)).toBe(true);
    expect(parseKeys("not json")).toBeUndefined();
  });
});
