import { randomBytes, scrypt } from "node:crypto";

export interface KdfParams {
  alg: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
}

const MAX_N = 2 ** 20;

export function defaultKdf(): KdfParams {
  return { alg: "scrypt", N: 2 ** 17, r: 8, p: 1, salt: randomBytes(16).toString("base64") };
}

export function deriveKey(passphrase: string, params: KdfParams): Promise<Buffer> {
  if (params.alg !== "scrypt" || params.N > MAX_N || params.r > 32 || params.p > 4) {
    return Promise.reject(new Error("This vault uses settings Hush doesn't support."));
  }
  const maxmem = 256 * params.N * params.r;
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize("NFKC"),
      Buffer.from(params.salt, "base64"),
      32,
      { N: params.N, r: params.r, p: params.p, maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
