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
