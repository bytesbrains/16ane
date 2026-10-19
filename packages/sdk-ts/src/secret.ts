import util from "node:util";

export const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";

/**
 * Redacts 32-byte hex strings when they appear next to key-like field names,
 * or redacts a known set of secret hex strings from arbitrary log/error text.
 */
export function redactSecrets(input: string, knownSecrets: string[] = []): string {
  let out = input;
  for (const secret of knownSecrets) {
    const clean = secret.startsWith("0x") ? secret.slice(2) : secret;
    if (clean.length === 64) {
      const re = new RegExp(`(?:0x)?${clean}`, "gi");
      out = out.replace(re, REDACTED_PRIVATE_KEY);
    }
  }
  out = out.replace(
    /((?:private[_-]?key|secret[_-]?key|owner[_-]?key|session[_-]?key|signing[_-]?key)["'\s:=]+)(?:0x)?[0-9a-fA-F]{64}/gi,
    `$1${REDACTED_PRIVATE_KEY}`,
  );
  return out;
}

/**
 * Non-enumerable, inspect-safe wrapper for a 32-byte secp256k1 private key (REQ-003, ADR-0010).
 * Never serializes the raw key via toString(), toJSON(), console.log(), or structuredClone.
 */
export class SecretKey {
  #rawHex: string;

  constructor(privateKeyHex: string) {
    const clean = privateKeyHex.trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean) || BigInt("0x" + clean) === 0n) {
      throw new Error("Invalid 32-byte secp256k1 private key");
    }
    this.#rawHex = "0x" + clean;
  }

  /**
   * Internal-only accessor used solely by in-memory signing functions.
   */
  unsafeUnwrap(): string {
    return this.#rawHex;
  }

  toString(): string {
    return REDACTED_PRIVATE_KEY;
  }

  toJSON(): string {
    return REDACTED_PRIVATE_KEY;
  }

  valueOf(): string {
    return REDACTED_PRIVATE_KEY;
  }

  [util.inspect.custom](): string {
    return `SecretKey(${REDACTED_PRIVATE_KEY})`;
  }
}
