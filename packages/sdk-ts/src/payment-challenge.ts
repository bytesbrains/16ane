// The x402 v2 402 challenge a merchant returns for an unpaid request.

import { randomBytes32Hex } from "./crypto.ts";
import { toChecksumAddress } from "./secp256k1.ts";
import type { MerchantEndpointConfig } from "./payment-checks.ts";
import type { X402PaymentRequirements, X402QuoteEnvelope } from "./x402.ts";

export const SANDBOX_DISCLAIMER = "TEST TOKENS (tANE) - NO CASH VALUE" as const;

export function build402Challenge(
  endpoint: MerchantEndpointConfig,
  canonicalResourceUrl: string,
  trialAvailable = false,
): {
  status: 402;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  quoteEnvelope: X402QuoteEnvelope;
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const maxTimeoutSeconds = endpoint.maxTimeoutSeconds ?? 300;
  const expiresAt = nowSec + maxTimeoutSeconds;
  const quoteId = `quote_${randomBytes32Hex().slice(2, 26)}`;
  const network = endpoint.network ?? "eip155:84532";
  const payTo = toChecksumAddress(endpoint.payTo);
  const asset = toChecksumAddress(endpoint.assetAddress);
  const amountStr = BigInt(endpoint.priceAmount).toString();

  const requirement: X402PaymentRequirements = {
    scheme: "ane-vault-v1",
    network,
    asset,
    assetSymbol: "tANE",
    amount: amountStr,
    payTo,
    maxTimeoutSeconds,
    resource: canonicalResourceUrl,
    description: endpoint.description ?? `Paid endpoint (${endpoint.serviceId})`,
    extra: {
      quoteId,
      expiresAt,
      serviceId: endpoint.serviceId,
      trialAvailable,
      disclaimer: SANDBOX_DISCLAIMER,
    },
  };

  const quoteEnvelope: X402QuoteEnvelope = {
    x402Version: 2,
    accepts: [requirement],
    error: "Payment Required: provide PAYMENT-SIGNATURE header with signed tANE SpendIntent",
  };

  const paymentRequiredB64 = Buffer.from(JSON.stringify(quoteEnvelope), "utf8").toString(
    "base64",
  );

  return {
    status: 402,
    headers: {
      "payment-required": paymentRequiredB64,
      "content-type": "application/json",
    },
    body: {
      error: {
        code: "ANE-E-4002",
        message: "Payment Required (x402 v2)",
        retryable: true,
        details: {
          quoteId,
          amount: amountStr,
          assetSymbol: "tANE",
          payTo,
          network,
        },
        disclaimer: SANDBOX_DISCLAIMER,
      },
    },
    quoteEnvelope,
  };
}
