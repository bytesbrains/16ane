import crypto from "node:crypto";
import { SecretKey } from "./secret.ts";

// ============================================================================
// 1. Pure Keccak-256 (Ethereum 0x01 padding)
// ============================================================================

const KECCAK_ROUNDS = 24;
const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const MASK_64 = 0xffffffffffffffffn;

function rotl64(x: bigint, n: number): bigint {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;
}

function keccakF1600(state: bigint[]): void {
  const bc = new Array<bigint>(5);
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    for (let i = 0; i < 5; i++) {
      bc[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^ state[i + 20];
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) {
        state[j + i] = (state[j + i] ^ t) & MASK_64;
      }
    }
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = state[j];
      state[j] = rotl64(t, ROTC[i]);
      t = tmp;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) {
        bc[i] = state[j + i];
      }
      for (let i = 0; i < 5; i++) {
        state[j + i] = (bc[i] ^ (~bc[(i + 1) % 5] & bc[(i + 2) % 5])) & MASK_64;
      }
    }
    state[0] = (state[0] ^ RC[round]) & MASK_64;
  }
}

export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rate = 136; // 1088 bits
  const state = new Array<bigint>(25).fill(0n);
  const paddedLen = Math.ceil((input.length + 1) / rate) * rate;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[input.length] ^= 0x01;
  buf[paddedLen - 1] ^= 0x80;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let offset = 0; offset < paddedLen; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      state[i] = (state[i] ^ view.getBigUint64(offset + i * 8, true)) & MASK_64;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    outView.setBigUint64(i * 8, state[i], true);
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${hex}`);
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function keccak256(data: string | Uint8Array): string {
  if (typeof data === "string") {
    if (data.startsWith("0x") || data.startsWith("0X")) {
      return bytesToHex(keccak256Bytes(hexToBytes(data)));
    }
    return bytesToHex(keccak256Bytes( Buffer.from(data, "utf8")));
  }
  return bytesToHex(keccak256Bytes(data));
}

export function keccak256Utf8(text: string): string {
  return bytesToHex(keccak256Bytes(Buffer.from(text, "utf8")));
}

// ============================================================================
// 2. Pure secp256k1 ECDSA (RFC 6979 deterministic k + EIP-2 low-S + recovery)
// ============================================================================

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

// ============================================================================
// 3. Minimal ABI Word Encoding & EIP-712 Hashing
// ============================================================================

export function abiWordUint(value: bigint | number | string): string {
  const n = BigInt(value);
  if (n < 0n) throw new Error("Unsigned integer cannot be negative");
  return n.toString(16).padStart(64, "0");
}

export function abiWordAddress(addr: string): string {
  const clean = addr.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid address for ABI encoding: ${addr}`);
  }
  return clean.padStart(64, "0");
}

export function abiWordBytes32(b32: string): string {
  const clean = b32.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid bytes32 for ABI encoding: ${b32}`);
  }
  return clean;
}

export function abiWordBool(flag: boolean): string {
  return flag ? "1".padStart(64, "0") : "0".padStart(64, "0");
}

export function functionSelector(signature: string): string {
  return keccak256Utf8(signature).slice(0, 10);
}

const EIP712_DOMAIN_TYPEHASH = keccak256Utf8(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
);

export const SPEND_INTENT_TYPEHASH = keccak256Utf8(
  "SpendIntent(address vault,address merchant,uint256 amount,bytes32 quoteId,bytes32 serviceIdHash,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint64 policyVersion)",
);

export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256Utf8(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
);

export const FAUCET_CLAIM_TYPEHASH = keccak256Utf8(
  "FaucetClaim(address recipient,bytes32 campaignId,uint256 deadline,bytes32 nonce)",
);

export const SERVICE_MANIFEST_TYPEHASH = keccak256Utf8(
  "ServiceManifest(string serviceId,string version,uint256 chainId,address payTo,address tokenAddress,bytes32 endpointsHash,uint64 updatedAt)",
);

export interface Eip712DomainInput {
  name: string;
  version: string;
  chainId: bigint | number;
  verifyingContract: string;
}

export function hashEip712Domain(domain: Eip712DomainInput): string {
  const encoded =
    "0x" +
    abiWordBytes32(EIP712_DOMAIN_TYPEHASH) +
    abiWordBytes32(keccak256Utf8(domain.name)) +
    abiWordBytes32(keccak256Utf8(domain.version)) +
    abiWordUint(domain.chainId) +
    abiWordAddress(domain.verifyingContract);
  return keccak256(encoded);
}

export function hashTypedDataDigest(domainSeparator: string, structHash: string): string {
  return keccak256("0x1901" + abiWordBytes32(domainSeparator) + abiWordBytes32(structHash));
}

export interface SpendIntent {
  vault: string;
  merchant: string;
  amount: string | bigint;
  quoteId: string;
  serviceIdHash: string;
  validAfter: number | bigint;
  validBefore: number | bigint;
  nonce: string;
  policyVersion: number | bigint;
}

export function hashSpendIntentStruct(intent: SpendIntent): string {
  const encoded =
    "0x" +
    abiWordBytes32(SPEND_INTENT_TYPEHASH) +
    abiWordAddress(intent.vault) +
    abiWordAddress(intent.merchant) +
    abiWordUint(intent.amount) +
    abiWordBytes32(intent.quoteId) +
    abiWordBytes32(intent.serviceIdHash) +
    abiWordUint(intent.validAfter) +
    abiWordUint(intent.validBefore) +
    abiWordBytes32(intent.nonce) +
    abiWordUint(intent.policyVersion);
  return keccak256(encoded);
}

export function computePaymentId(
  chainId: bigint | number,
  vault: string,
  merchant: string,
  quoteId: string,
  nonce: string,
): string {
  return keccak256(
    "0x" +
      abiWordUint(chainId) +
      abiWordAddress(vault) +
      abiWordAddress(merchant) +
      abiWordBytes32(quoteId) +
      abiWordBytes32(nonce),
  );
}

export function hashSpendIntent(chainId: bigint | number, intent: SpendIntent): {
  domainSeparator: string;
  structHash: string;
  digest: string;
  paymentId: string;
} {
  const domainSeparator = hashEip712Domain({
    name: "AneAgentVault",
    version: "1",
    chainId,
    verifyingContract: intent.vault,
  });
  const structHash = hashSpendIntentStruct(intent);
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  const paymentId = computePaymentId(
    chainId,
    intent.vault,
    intent.merchant,
    intent.quoteId,
    intent.nonce,
  );
  return { domainSeparator, structHash, digest, paymentId };
}

export interface TransferWithAuthorization {
  from: string;
  to: string;
  value: string | bigint;
  validAfter: number | bigint;
  validBefore: number | bigint;
  nonce: string;
}

export function hashTransferWithAuthorization(
  chainId: bigint | number,
  tokenAddress: string,
  auth: TransferWithAuthorization,
  tokenName = "16ane Sandbox (NO CASH VALUE)",
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
} {
  const domainSeparator = hashEip712Domain({
    name: tokenName,
    version: "1",
    chainId,
    verifyingContract: tokenAddress,
  });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(TRANSFER_WITH_AUTHORIZATION_TYPEHASH) +
      abiWordAddress(auth.from) +
      abiWordAddress(auth.to) +
      abiWordUint(auth.value) +
      abiWordUint(auth.validAfter) +
      abiWordUint(auth.validBefore) +
      abiWordBytes32(auth.nonce),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest };
}

export interface ClaimAuthorization {
  recipient: string;
  campaignId?: string;
  deadline: number | bigint;
  nonce: string;
}

export function hashClaimAuthorization(
  chainId: bigint | number,
  faucetAddress: string,
  claim: ClaimAuthorization,
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
} {
  const domainSeparator = hashEip712Domain({
    name: "AneFaucet",
    version: "1",
    chainId,
    verifyingContract: faucetAddress,
  });
  const campaignId = claim.campaignId ?? "0x" + "00".repeat(32);
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(FAUCET_CLAIM_TYPEHASH) +
      abiWordAddress(claim.recipient) +
      abiWordBytes32(campaignId) +
      abiWordUint(claim.deadline) +
      abiWordBytes32(claim.nonce),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest };
}

export interface ServiceManifestEndpoint {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  priceAmount: string;
  scheme: "ane-vault-v1" | "exact";
  description?: string;
}

export interface ServiceManifestPayload {
  schemaVersion: "16ane-manifest-v0";
  serviceId: string;
  name: string;
  description?: string;
  version: string;
  network: "eip155:84532" | "eip155:31337";
  chainId: number;
  payTo: string;
  tokenAddress: string;
  tokenSymbol: "tANE";
  updatedAt: number;
  endpoints: ServiceManifestEndpoint[];
  trialQuota?: {
    enabled: boolean;
    freeCallsPerCaller: number;
    globalDailyCap: number;
    sponsorDisclosure: string;
  };
  signer?: string;
  signature?: string;
}

export function hashManifestEndpoints(endpoints: ServiceManifestEndpoint[]): string {
  const canonical = endpoints
    .map((e) => `${e.id}:${e.method}:${e.path}:${e.priceAmount}:${e.scheme}`)
    .join("|");
  return keccak256Utf8(canonical);
}

export function hashServiceManifest(
  manifest: ServiceManifestPayload,
  verifyingDirectory = "0x0000000000000000000000000000000000000000",
): {
  domainSeparator: string;
  structHash: string;
  digest: string;
  endpointsHash: string;
} {
  const endpointsHash = hashManifestEndpoints(manifest.endpoints);
  const domainSeparator = hashEip712Domain({
    name: "16ane.ServiceManifest",
    version: "1",
    chainId: manifest.chainId,
    verifyingContract: verifyingDirectory,
  });
  const structHash = keccak256(
    "0x" +
      abiWordBytes32(SERVICE_MANIFEST_TYPEHASH) +
      abiWordBytes32(keccak256Utf8(manifest.serviceId)) +
      abiWordBytes32(keccak256Utf8(manifest.version)) +
      abiWordUint(manifest.chainId) +
      abiWordAddress(manifest.payTo) +
      abiWordAddress(manifest.tokenAddress) +
      abiWordBytes32(endpointsHash) +
      abiWordUint(manifest.updatedAt),
  );
  const digest = hashTypedDataDigest(domainSeparator, structHash);
  return { domainSeparator, structHash, digest, endpointsHash };
}

export function computeResourceHash(method: string, canonicalUrl: string): string {
  const u = new URL(canonicalUrl);
  const normalized = `${method.toUpperCase()}:${u.origin.toLowerCase()}${u.pathname}${u.search}`;
  return keccak256Utf8(normalized);
}

export function computeRequestHash(body: string | Uint8Array | undefined | null): string {
  if (!body) {
    return keccak256Utf8("");
  }
  return typeof body === "string" ? keccak256Utf8(body) : keccak256(body);
}

export function randomBytes32Hex(): string {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

export function generateKeypair(): { secretKey: SecretKey; address: string } {
  const raw = "0x" + crypto.randomBytes(32).toString("hex");
  const secretKey = new SecretKey(raw);
  const address = privateKeyToAddress(secretKey);
  return { secretKey, address };
}
