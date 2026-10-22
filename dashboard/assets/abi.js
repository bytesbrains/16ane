// Minimal ABI encoding/decoding for the dashboard's contract calls. The word
// encoders mirror packages/sdk-ts/src/abi.ts and the decoders mirror the
// client.ts readers; equivalence is enforced by test/dashboard/abi.test.ts.
import { keccak256Utf8 } from "./keccak.js";

export function abiWordUint(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error("Unsigned integer cannot be negative");
  return n.toString(16).padStart(64, "0");
}

export function abiWordAddress(addr) {
  const clean = addr.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid address for ABI encoding: ${addr}`);
  }
  return clean.padStart(64, "0");
}

export function abiWordBytes32(b32) {
  const clean = b32.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid bytes32 for ABI encoding: ${b32}`);
  }
  return clean;
}

export function abiWordBool(flag) {
  return flag ? "1".padStart(64, "0") : "0".padStart(64, "0");
}

export function functionSelector(signature) {
  return keccak256Utf8(signature).slice(0, 10);
}

export function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function toChecksumAddress(address) {
  const clean = address.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  const hash = keccak256Utf8(clean).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? clean[i].toUpperCase() : clean[i];
  }
  return out;
}

export function splitWords(hexData) {
  const clean = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const words = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    words.push(clean.slice(i, i + 64));
  }
  return words;
}

export function wordToBigInt(word) {
  return BigInt("0x" + (word || "0"));
}

export function wordToAddress(word) {
  return toChecksumAddress("0x" + (word || "0".repeat(64)).slice(-40));
}

export function wordToNumber(word) {
  return Number(wordToBigInt(word));
}

// wei-style human formatting for a decimals-bearing token: "16000000000000000000" -> "16".
export function formatUnits(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const head = digits.slice(0, -decimals) || "0";
  const tail = digits.slice(-decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + (tail ? `${head}.${tail}` : head);
}

export function parseUnits(text, decimals) {
  const match = /^(0|[1-9][0-9]*)(\.[0-9]*)?$/.exec(text.trim());
  if (!match) throw new Error(`Not a decimal amount: ${text}`);
  const frac = (match[2] ?? ".").slice(1).padEnd(decimals, "0").slice(0, decimals);
  if ((match[2] ?? "").length - 1 > decimals) throw new Error(`Too many decimals: ${text}`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
