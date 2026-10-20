// Signs and verifies service manifests (ADR-0007): an EIP-712 digest bound to the service directory's address.
import { hashServiceManifest, type ServiceManifestPayload } from "./crypto.ts";
import type { SecretKey } from "./secret.ts";
import { recoverAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";

export function signServiceManifest(
  manifest: Omit<ServiceManifestPayload, "signer" | "signature">,
  signerKey: SecretKey,
  dir: string,
): ServiceManifestPayload {
  const full: ServiceManifestPayload = {
    ...manifest,
    payTo: toChecksumAddress(manifest.payTo),
    tokenAddress: toChecksumAddress(manifest.tokenAddress),
  };
  const { digest } = hashServiceManifest(full, dir);
  const sig = signDigest(digest, signerKey);
  const signer = recoverAddress(digest, sig.serialized);
  return {
    ...full,
    signer,
    signature: sig.serialized,
  };
}

export function verifyServiceManifest(
  manifest: ServiceManifestPayload,
  dir: string,
): { valid: boolean; signer?: string; digest: string; reason?: string } {
  if (!manifest.signature || !manifest.signer) {
    return { valid: false, digest: "0x", reason: "Missing manifest signature or signer" };
  }
  const { digest } = hashServiceManifest(manifest, dir);
  try {
    const recovered = recoverAddress(digest, manifest.signature);
    if (recovered.toLowerCase() !== manifest.signer.toLowerCase()) {
      return {
        valid: false,
        signer: recovered,
        digest,
        reason: `Manifest signature mismatch: recovered ${recovered}, expected ${manifest.signer}`,
      };
    }
    return { valid: true, signer: recovered, digest };
  } catch (err) {
    return {
      valid: false,
      digest,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
