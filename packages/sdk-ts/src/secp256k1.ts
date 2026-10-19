// Pure secp256k1 ECDSA (RFC 6979 deterministic k + EIP-2 low-S + recovery)
import crypto from "node:crypto";
import { hexToBytes, keccak256, keccak256Utf8 } from "./keccak.ts";
import { SecretKey } from "./secret.ts";

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_HALF_N = SECP_N >> 1n;
const SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const SECP_GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

interface Point {
  x: bigint;
  y: bigint;
}

function mod(a: bigint, m: bigint = SECP_P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modInv(a: bigint, m: bigint = SECP_P): bigint {
  let [t, newT] = [0n, 1n];
  let [r, newR] = [m, mod(a, m)];
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error("Not invertible");
  return t < 0n ? t + m : t;
}

function modPow(base: bigint, exp: bigint, m: bigint = SECP_P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function pointAdd(p1: Point | null, p2: Point | null): Point | null {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x && p1.y !== p2.y) return null;
  const lam =
    p1.x === p2.x
      ? mod(3n * p1.x * p1.x * modInv(2n * p1.y))
      : mod((p2.y - p1.y) * modInv(p2.x - p1.x));
  const x3 = mod(lam * lam - p1.x - p2.x);
  const y3 = mod(lam * (p1.x - x3) - p1.y);
  return { x: x3, y: y3 };
}

function pointMul(k: bigint, p: Point = { x: SECP_GX, y: SECP_GY }): Point {
  let scalar = mod(k, SECP_N);
  if (scalar === 0n) throw new Error("Invalid zero scalar");
  let result: Point | null = null;
  let addend: Point | null = p;
  while (scalar > 0n) {
    if (scalar & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    scalar >>= 1n;
  }
  if (!result) throw new Error("Point at infinity");
  return result;
}

function bigintTo32Bytes(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

function bytesToBigint(b: Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(b).toString("hex"));
}

function rfc6979Nonce(msgHashBytes: Uint8Array, privKey: bigint): bigint {
  const x = bigintTo32Bytes(privKey);
  const h1 = bigintTo32Bytes(mod(bytesToBigint(msgHashBytes), SECP_N));
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);

  const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

  k = hmac(k, Buffer.concat([v, Buffer.from([0x00]), x, h1]));
  v = hmac(k, v);
  k = hmac(k, Buffer.concat([v, Buffer.from([0x01]), x, h1]));
  v = hmac(k, v);

  while (true) {
    v = hmac(k, v);
    const candidate = bytesToBigint(v);
    if (candidate >= 1n && candidate < SECP_N) {
      return candidate;
    }
    k = hmac(k, Buffer.concat([v, Buffer.from([0x00])]));
    v = hmac(k, v);
  }
}

export function toChecksumAddress(address: string): string {
  const clean = address.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  const hash = keccak256Utf8(clean).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? clean[i].toUpperCase() : clean[i];
  }
  return out;
}

export function privateKeyToAddress(key: string | SecretKey): string {
  const raw = key instanceof SecretKey ? key.unsafeUnwrap() : key;
  const priv = BigInt(raw.startsWith("0x") ? raw : "0x" + raw);
  const pub = pointMul(priv);
  const pubBytes = Buffer.concat([bigintTo32Bytes(pub.x), bigintTo32Bytes(pub.y)]);
  const addrHex = keccak256(pubBytes).slice(-40);
  return toChecksumAddress("0x" + addrHex);
}

export interface EcdsaSignature {
  r: string;
  s: string;
  v: number;
  serialized: string;
}

export function signDigest(digestHex: string, key: string | SecretKey): EcdsaSignature {
  const rawKey = key instanceof SecretKey ? key.unsafeUnwrap() : key;
  const priv = BigInt(rawKey.startsWith("0x") ? rawKey : "0x" + rawKey);
  const digestBytes = hexToBytes(digestHex);
  if (digestBytes.length !== 32) {
    throw new Error("Digest must be 32 bytes");
  }
  const z = mod(bytesToBigint(digestBytes), SECP_N);
  const k = rfc6979Nonce(digestBytes, priv);
  const R = pointMul(k);
  const r = mod(R.x, SECP_N);
  if (r === 0n) throw new Error("Invalid r=0");
  let s = mod(modInv(k, SECP_N) * (z + r * priv), SECP_N);
  if (s === 0n) throw new Error("Invalid s=0");
  let recid = Number(R.y & 1n);
  if (s > SECP_HALF_N) {
    s = SECP_N - s;
    recid ^= 1;
  }
  const v = 27 + recid;
  const rHex = "0x" + r.toString(16).padStart(64, "0");
  const sHex = "0x" + s.toString(16).padStart(64, "0");
  const vHex = v.toString(16).padStart(2, "0");
  return {
    r: rHex,
    s: sHex,
    v,
    serialized: rHex + sHex.slice(2) + vHex,
  };
}

export function recoverAddress(digestHex: string, signatureHex: string): string {
  const sigBytes = hexToBytes(signatureHex);
  if (sigBytes.length !== 65) {
    throw new Error("Invalid 65-byte ECDSA signature");
  }
  const r = bytesToBigint(sigBytes.subarray(0, 32));
  const s = bytesToBigint(sigBytes.subarray(32, 64));
  let v = sigBytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("Invalid recovery id v");
  if (r <= 0n || r >= SECP_N || s <= 0n || s > SECP_HALF_N) {
    throw new Error("Invalid signature parameters r/s");
  }

  const x = r;
  const yCubed = mod(modPow(x, 3n) + 7n);
  let y = modPow(yCubed, (SECP_P + 1n) / 4n);
  if (mod(y * y) !== yCubed) {
    throw new Error("Point not on curve");
  }
  if (Number(y & 1n) !== v) {
    y = SECP_P - y;
  }
  const R: Point = { x, y };
  const z = mod(bytesToBigint(hexToBytes(digestHex)), SECP_N);
  const rInv = modInv(r, SECP_N);
  const u1 = mod(SECP_N - mod(z * rInv, SECP_N), SECP_N);
  const u2 = mod(s * rInv, SECP_N);
  const Q = pointAdd(
    u1 === 0n ? null : pointMul(u1),
    u2 === 0n ? null : pointMul(u2, R),
  );
  if (!Q) throw new Error("Recovered point at infinity");
  const pubBytes = Buffer.concat([bigintTo32Bytes(Q.x), bigintTo32Bytes(Q.y)]);
  return toChecksumAddress("0x" + keccak256(pubBytes).slice(-40));
}

export function generateKeypair(): { secretKey: SecretKey; address: string } {
  const raw = "0x" + crypto.randomBytes(32).toString("hex");
  const secretKey = new SecretKey(raw);
  const address = privateKeyToAddress(secretKey);
  return { secretKey, address };
}
