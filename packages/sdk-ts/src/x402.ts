import { type ServiceManifestPayload } from "./crypto.ts";

export interface X402PaymentRequirements {
  scheme: "ane-vault-v1" | "exact";
  network: "eip155:84532" | "eip155:31337";
  asset: string;
  assetSymbol: "tANE";
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource: string;
  description?: string;
  extra?: {
    quoteId?: string;
    expiresAt?: number;
    serviceId?: string;
    trialAvailable?: boolean;
    disclaimer?: string;
  };
}

export interface X402QuoteEnvelope {
  x402Version: 2;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface X402Receipt {
  x402Version: 2;
  success: boolean;
  scheme: "ane-vault-v1" | "exact" | "sponsored-trial";
  network: "eip155:84532" | "eip155:31337";
  txHash: string;
  blockNumber: number;
  intentId?: string;
  paymentId?: string;
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
  resourceHash: string;
  requestHash: string;
  idempotencyKey?: string;
  settledAt: string;
  sponsored?: boolean;
  /** The sponsoring campaign (ADR-0008); set on sponsored-trial receipts only. */
  campaignId?: string;
  disclaimer: string;
}

export interface PurchaseOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  maxPayment?: bigint | string;
  /** Refuse a quote that pays anyone else (set by `AgentSession.purchaseRouted`). */
  expectedPayTo?: string;
  idempotencyKey?: string;
  manifest?: ServiceManifestPayload;
  verifyManifest?: boolean;
  verifyReceiptOnChain?: boolean;
  settleDirectOnChain?: boolean;
}

export interface PurchaseResult<T = unknown> {
  status: number;
  data: T;
  receipt?: X402Receipt;
  trialSponsored: boolean;
  trialRemaining?: number;
  headers: Record<string, string>;
}
