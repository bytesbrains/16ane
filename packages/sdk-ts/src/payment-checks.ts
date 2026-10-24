// Static (chain-free) validity checks for x402 payment payloads, shared by
// merchants (AnePaymentVerifier) and the facilitator so verify and settle can
// never disagree on what a valid payment is. Nothing here reads the chain or
// the replay store; callers layer those on top.

import {
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  hashTransferWithAuthorization,
  type SpendIntent,
  type TransferWithAuthorization,
} from "./crypto.ts";
import { toChecksumAddress } from "./secp256k1.ts";

export interface MerchantEndpointConfig {
  serviceId: string;
  priceAmount: bigint | string;
  payTo: string;
  assetAddress: string;
  network?: "eip155:84532" | "eip155:31337";
  description?: string;
  maxTimeoutSeconds?: number;
}

/** A parsed x402 payment: the base64 PAYMENT-SIGNATURE header decoded, or a facilitator's paymentPayload mapped onto it. */
export interface X402DecodedPayment {
  x402Version: number;
  scheme: "ane-vault-v1" | "exact";
  network: "eip155:84532" | "eip155:31337";
  accepted: { asset: string; amount: string; payTo: string };
  payload: Record<string, unknown>;
}

export type VaultPaymentPayload = SpendIntent & {
  resourceHash?: string;
  requestHash?: string;
  signature: string;
  txHash?: string;
};

export type ExactPaymentPayload = TransferWithAuthorization & { signature: string };

/** What the HTTP request binds a payment to. Merchants always pass it; a facilitator has no request to bind. */
export interface PaymentBinding {
  method: string;
  canonicalUrl: string;
  rawBody?: string;
}

// Static (chain-free) checks for an ane-vault-v1 payload, shared by merchants and the facilitator so
// verify and settle can never disagree on validity. Request binding applies only when the caller passes
// what the payment binds to; merchants always do, a facilitator has no request to bind.
export function checkVaultPayment(
  chainId: number,
  p: VaultPaymentPayload,
  endpoint: MerchantEndpointConfig,
  binding: PaymentBinding | undefined,
):
  | {
      ok: true;
      intentId: string;
      digest: string;
      paymentId: string;
      directTxHash: string | undefined;
      payer: string;
      proofIds: string[];
    }
  | { ok: false; failure: { status: number; code: string; message: string } } {
  const fail = (status: number, code: string, message: string) => ({ ok: false as const, failure: { status, code, message } });
  if (binding) {
    // The client signs the URL it called, but a TLS-terminating proxy hides the scheme from the
    // server (our reference server only ever sees http): accept the hash for either scheme (#109).
    // The scheme is not a security boundary — host, path, method and query stay bound either way.
    const swapScheme = (url: string) =>
      url.replace(/^https?:\/\//i, (m) => (m.toLowerCase() === "https://" ? "http://" : "https://"));
    const expectedResourceHashes = [binding.canonicalUrl, swapScheme(binding.canonicalUrl)].map((u) =>
      computeResourceHash(binding.method, u).toLowerCase(),
    );
    const requestMismatch =
      binding.rawBody !== undefined &&
      p.requestHash !== undefined &&
      p.requestHash.toLowerCase() !== computeRequestHash(binding.rawBody).toLowerCase();
    if (
      (p.resourceHash && !expectedResourceHashes.includes(p.resourceHash.toLowerCase())) ||
      requestMismatch
    ) {
      return fail(400, "ANE-E-4006", "SpendIntent resourceHash or requestHash does not match HTTP request");
    }
  }
  const requiredAmount = BigInt(endpoint.priceAmount);
  const expectedPayTo = toChecksumAddress(endpoint.payTo);
  if (p.merchant.toLowerCase() !== expectedPayTo.toLowerCase()) {
    return fail(
      400,
      "ANE-E-4007",
      `SpendIntent merchant (${p.merchant}) does not match merchant payTo (${expectedPayTo})`,
    );
  }
  if (BigInt(p.amount) < requiredAmount) {
    return fail(402, "ANE-E-4008", `SpendIntent amount (${p.amount}) is less than required (${requiredAmount})`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(p.validBefore) <= nowSec) {
    return fail(402, "ANE-E-4003", `SpendIntent expired at ${p.validBefore} (now ${nowSec})`);
  }

  const {
    structHash: intentId,
    digest,
    paymentId,
  } = hashSpendIntent(chainId, p);
  const directTxHash = p.txHash && p.txHash !== "0x" + "00".repeat(32) ? p.txHash : undefined;
  const proofIds = directTxHash ? [intentId, paymentId, directTxHash] : [intentId, paymentId];
  return { ok: true, intentId, digest, paymentId, directTxHash, payer: toChecksumAddress(p.vault), proofIds };
}

// Static checks for an exact (EIP-3009) payload. Time bounds and funds are enforced where the
// authorization executes: on-chain at settle, or by simulation in verify-only and preflight.
export function checkExactPayment(
  chainId: number,
  p: ExactPaymentPayload,
  endpoint: MerchantEndpointConfig,
):
  | { ok: true; structHash: string; digest: string; payer: string }
  | { ok: false; failure: { status: number; code: string; message: string } } {
  const fail = (status: number, code: string, message: string) => ({ ok: false as const, failure: { status, code, message } });
  const requiredAmount = BigInt(endpoint.priceAmount);
  const expectedPayTo = toChecksumAddress(endpoint.payTo);
  const expectedAsset = toChecksumAddress(endpoint.assetAddress);
  if (p.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
    return fail(
      400,
      "ANE-E-4007",
      `Authorization recipient (${p.to}) does not match merchant payTo (${expectedPayTo})`,
    );
  }
  if (BigInt(p.value) < requiredAmount) {
    return fail(402, "ANE-E-4008", `Authorization value (${p.value}) is less than required (${requiredAmount})`);
  }
  const { structHash, digest } = hashTransferWithAuthorization(
    chainId,
    expectedAsset,
    p,
  );
  return { ok: true, structHash, digest, payer: toChecksumAddress(p.from) };
}
