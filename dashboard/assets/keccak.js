// Pure Keccak-256 (Ethereum 0x01 padding), without Node APIs.
// Mechanically ported from packages/sdk-ts/src/keccak.ts: only the Buffer-based
// hex conversions differ (TextEncoder plus manual hex here). Equivalence is
// enforced by test/dashboard/abi.test.ts — change both files together.

const KECCAK_ROUNDS = 24;
const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const MASK_64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;
}

function keccakF1600(state) {
  const bc = new Array(5);
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

export function keccak256Bytes(input) {
  const rate = 136; // 1088 bits
  const state = new Array(25).fill(0n);
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

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes) {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function keccak256(data) {
  if (typeof data === "string") {
    if (data.startsWith("0x") || data.startsWith("0X")) {
      return bytesToHex(keccak256Bytes(hexToBytes(data)));
    }
    return bytesToHex(keccak256Bytes(new TextEncoder().encode(data)));
  }
  return bytesToHex(keccak256Bytes(data));
}

export function keccak256Utf8(text) {
  return bytesToHex(keccak256Bytes(new TextEncoder().encode(text)));
}
