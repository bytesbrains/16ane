import { keccak256 } from "./keccak.ts";
import { privateKeyToAddress, recoverAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";
import type { SecretKey } from "./secret.ts";

// ---- provider circuit-breaker signatures --------------------------------------------------------
// Pause/resume requests are authorized by the campaign provider's key, not by a server login, so
// any self-hosted quota engine enforces the same control. The message is EIP-191 personal-signed
// ("Signed by the provider" is checkable with secp256k1 recovery alone) and carries a short
// deadline so a captured control cannot be replayed later.

export type CampaignControlAction = "pause" | "resume";

export interface SignedCampaignControl {
  providerId: string;
  campaignId: string;
  action: CampaignControlAction;
  deadline: number;
  signature: string;
}

const CONTROL_PREFIX = "16ane campaign control";

export function campaignControlMessage(control: {
  providerId: string;
  campaignId: string;
  action: CampaignControlAction;
  deadline: number;
}): string {
  return (
    `${CONTROL_PREFIX}\nprovider: ${control.providerId.toLowerCase()}\n` +
    `campaign: ${control.campaignId}\naction: ${control.action}\ndeadline: ${control.deadline}`
  );
}

export function hashCampaignControlMessage(message: string): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

export function signCampaignControl(
  providerKey: string | SecretKey,
  control: { campaignId: string; action: CampaignControlAction; deadline: number },
): SignedCampaignControl {
  // The address is derived from the key, never taken from caller input.
  const providerId = toChecksumAddress(privateKeyToAddress(providerKey));
  const message = campaignControlMessage({ providerId, ...control });
  return {
    providerId,
    campaignId: control.campaignId,
    action: control.action,
    deadline: control.deadline,
    signature: signDigest(hashCampaignControlMessage(message), providerKey).serialized,
  };
}

export function verifyCampaignControl(
  control: SignedCampaignControl,
  expectedProviderId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  if (control.action !== "pause" && control.action !== "resume") {
    return { valid: false, reason: "action must be pause or resume" };
  }
  if (!Number.isSafeInteger(control.deadline) || control.deadline <= nowSec || control.deadline > nowSec + 3600) {
    return { valid: false, reason: "deadline must be within the next hour" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(control.providerId)) {
    return { valid: false, reason: "providerId must be an address" };
  }
  let signer: string;
  try {
    signer = recoverAddress(hashCampaignControlMessage(campaignControlMessage(control)), control.signature);
  } catch {
    return { valid: false, reason: "the signature is invalid" };
  }
  if (signer.toLowerCase() !== control.providerId.toLowerCase()) {
    return { valid: false, reason: "not signed by the providerId" };
  }
  if (signer.toLowerCase() !== expectedProviderId.toLowerCase()) {
    return { valid: false, reason: "not signed by this campaign's provider" };
  }
  return { valid: true };
}
