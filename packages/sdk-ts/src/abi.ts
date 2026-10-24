// Minimal ABI word encoding
import { keccak256Utf8 } from "./keccak.ts";

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

// A dynamic `bytes` value's tail: its length word, then the data right-padded to whole words.
export function abiBytesTail(hex: string): string {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(clean)) throw new Error("Invalid bytes for ABI encoding");
  const padded = clean.padEnd(Math.ceil(clean.length / 64) * 64, "0");
  return abiWordUint(clean.length / 2) + padded;
}

// Calldata for a function whose arguments are static words followed by one trailing `bytes` argument (the
// shape of every signature-carrying call the relayer makes). Each staticWord must already be a 32-byte hex
// word with no 0x prefix (as returned by abiWordUint / abiWordAddress / abiWordBytes32).
export function encodeCallWithTrailingBytes(signature: string, staticWords: string[], bytesHex: string): string {
  for (const word of staticWords) {
    if (!/^[0-9a-fA-F]{64}$/.test(word)) {
      throw new Error(`Invalid static ABI word (need 64 hex chars, no 0x): ${word}`);
    }
  }
  const offset = abiWordUint((staticWords.length + 1) * 32);
  return functionSelector(signature) + staticWords.join("") + offset + abiBytesTail(bytesHex);
}

// Minimal ABI decoding of call results and event data: the 32-byte word at `index`, and a dynamic
// `bytes`/`string` value whose offset sits at `index`.
export function abiReadWord(hex: string, index: number): bigint {
  const clean = hex.replace(/^0x/i, "");
  const word = clean.slice(index * 64, (index + 1) * 64);
  if (word.length !== 64) throw new Error(`ABI data too short for word ${index}`);
  return BigInt("0x" + word);
}

export function abiReadBytes(hex: string, index: number): string {
  const clean = hex.replace(/^0x/i, "");
  const offset = Number(abiReadWord(clean, index));
  if (offset % 32 !== 0) throw new Error("Malformed ABI offset");
  const length = Number(abiReadWord(clean, offset / 32));
  const start = offset * 2 + 64;
  const data = clean.slice(start, start + length * 2);
  if (data.length !== length * 2) throw new Error("ABI bytes run past the data");
  return "0x" + data;
}

export function abiReadString(hex: string, index: number): string {
  return Buffer.from(abiReadBytes(hex, index).slice(2), "hex").toString("utf8");
}
