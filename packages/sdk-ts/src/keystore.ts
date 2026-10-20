import { createCipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bytesToHex, hexToBytes, keccak256Bytes } from "./keccak.ts";
import { privateKeyToAddress } from "./secp256k1.ts";

// scrypt cost for a keystore that lives only for one `cast send`: strong enough for a random 256-bit password,
// cheap enough (16 MiB, tens of milliseconds) to pay per transaction.
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Encrypts a private key as a Web3 Secret Storage (V3) keystore: scrypt, aes-128-ctr, keccak-256 MAC. */
export async function encryptKeystoreV3(privateKeyHex: string, password: string): Promise<Record<string, unknown>> {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(hexToBytes(privateKeyHex))), cipher.final()]);
  const mac = keccak256Bytes(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  return {
    version: 3,
    id: randomUUID(),
    address: privateKeyToAddress(privateKeyHex).slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams: { dklen: 32, n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("hex") },
      mac: bytesToHex(mac).slice(2),
    },
  };
}

/**
 * Runs `fn` with environment variables that let Foundry's `cast` sign with `privateKeyHex` without the key
 * appearing in any process's arguments (#67). The key is written as an encrypted keystore with a random
 * password into a private temporary directory (`mkdtemp`, mode 0700; files 0600), passed to `cast` as
 * ETH_KEYSTORE / ETH_PASSWORD (a path to the password file), and deleted afterwards.
 */
export async function withTemporaryKeystore<T>(
  privateKeyHex: string,
  fn: (env: { ETH_KEYSTORE: string; ETH_PASSWORD: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "16ane-cast-"));
  try {
    const password = randomBytes(32).toString("hex");
    const keystorePath = path.join(dir, "keystore.json");
    const passwordPath = path.join(dir, "password");
    await writeFile(keystorePath, JSON.stringify(await encryptKeystoreV3(privateKeyHex, password)), { mode: 0o600 });
    await writeFile(passwordPath, password, { mode: 0o600 });
    return await fn({ ETH_KEYSTORE: keystorePath, ETH_PASSWORD: passwordPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
