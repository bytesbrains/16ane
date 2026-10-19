import { type AneClient } from "./client.ts";
import {
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  hashTransferWithAuthorization,
  randomBytes32Hex,
  recoverAddress,
  toChecksumAddress,
  type SpendIntent,
  type TransferWithAuthorization,
} from "./crypto.ts";
import { type SecretKey } from "./secret.ts";
import {
  type X402PaymentRequirements,
  type X402QuoteEnvelope,
  type X402Receipt,
} from "./wallet.ts";

export const SANDBOX_DISCLAIMER = "TEST TOKENS (tANE) - NO CASH VALUE" as const;

export interface TrialQuotaConfig {
  enabled: boolean;
  freeCallsPerCaller: number;
  globalDailyCap: number;
  sponsorDisclosure?: string;
}

export class TrialQuotaTracker {
  readonly config: TrialQuotaConfig;
  private callerCounts = new Map<string, number>();
  private globalUsedToday = 0;
  private currentDayKey = new Date().toISOString().slice(0, 10);

  constructor(config: TrialQuotaConfig) {
    this.config = config;
  }

  private rollDayIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDayKey) {
      this.currentDayKey = today;
      this.globalUsedToday = 0;
      this.callerCounts.clear();
    }
  }

  checkAndConsume(callerId: string): {
    allowed: boolean;
    remainingCallerQuota: number;
    remainingGlobalQuota: number;
    disclosure: string;
  } {
    this.rollDayIfNeeded();
    const disclosure =
      this.config.sponsorDisclosure ??
      "Provider-sponsored sandbox compute trial (0 tANE charged; strict per-caller & global daily cap)";
    if (!this.config.enabled) {
      return {
        allowed: false,
        remainingCallerQuota: 0,
        remainingGlobalQuota: 0,
        disclosure,
      };
    }
    const usedByCaller = this.callerCounts.get(callerId.toLowerCase()) ?? 0;
    if (
      usedByCaller >= this.config.freeCallsPerCaller ||
      this.globalUsedToday >= this.config.globalDailyCap
    ) {
      return {
        allowed: false,
        remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - usedByCaller),
        remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - this.globalUsedToday),
        disclosure,
      };
    }
    const nextCaller = usedByCaller + 1;
    this.callerCounts.set(callerId.toLowerCase(), nextCaller);
    this.globalUsedToday += 1;
    return {
      allowed: true,
      remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - nextCaller),
      remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - this.globalUsedToday),
      disclosure,
    };
  }
}

export interface CachedIdempotentResponse {
  requestHash: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  receipt: X402Receipt;
}

export interface MerchantEndpointConfig {
  serviceId: string;
  priceAmount: bigint | string;
  payTo: string;
  assetAddress: string;
  network?: "eip155:84532" | "eip155:31337";
  description?: string;
  maxTimeoutSeconds?: number;
}

export class AnePaymentVerifier {
  readonly client: AneClient;
  readonly relayerKey: SecretKey;
  private idempotencyStore = new Map<string, CachedIdempotentResponse>();
  private consumedProofs = new Set<string>();
  private receiptsById = new Map<string, X402Receipt>();

  constructor(params: { client: AneClient; relayerKey: SecretKey }) {
    this.client = params.client;
    this.relayerKey = params.relayerKey;
  }

  getReceipt(idOrTxHash: string): X402Receipt | undefined {
    return this.receiptsById.get(idOrTxHash.toLowerCase());
  }

  listReceipts(): X402Receipt[] {
    const unique = new Map<string, X402Receipt>();
    for (const r of this.receiptsById.values()) {
      unique.set(r.txHash.toLowerCase(), r);
    }
    return Array.from(unique.values());
  }

  recordReceipt(receipt: X402Receipt): void {
    this.receiptsById.set(receipt.txHash.toLowerCase(), receipt);
    if (receipt.intentId) {
      this.receiptsById.set(receipt.intentId.toLowerCase(), receipt);
    }
    if (receipt.paymentId) {
      this.receiptsById.set(receipt.paymentId.toLowerCase(), receipt);
    }
  }

  checkIdempotency(
    idempotencyKey: string | undefined,
    requestHash: string,
  ):
    | { status: "MISS" }
    | { status: "HIT"; cached: CachedIdempotentResponse }
    | { status: "CONFLICT"; message: string } {
    if (!idempotencyKey) {
      return { status: "MISS" };
    }
    const existing = this.idempotencyStore.get(idempotencyKey);
    if (!existing) {
      return { status: "MISS" };
    }
    if (existing.requestHash.toLowerCase() !== requestHash.toLowerCase()) {
      return {
        status: "CONFLICT",
        message: `ANE-E-4004: Idempotency-Key '${idempotencyKey}' was already used with a different request payload hash`,
      };
    }
    return { status: "HIT", cached: existing };
  }

  saveIdempotentResponse(
    idempotencyKey: string | undefined,
    entry: CachedIdempotentResponse,
  ): void {
    if (idempotencyKey) {
      this.idempotencyStore.set(idempotencyKey, entry);
    }
  }

  build402Challenge(
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

  async verifyAndSettle(params: {
    paymentSignatureHeader: string;
    endpoint: MerchantEndpointConfig;
    method: string;
    canonicalUrl: string;
    rawBody?: string;
    idempotencyKey?: string;
  }): Promise<
    | { ok: true; receipt: X402Receipt; receiptHeaderB64: string }
    | { ok: false; status: number; code: string; message: string }
  > {
    let decoded: {
      x402Version: number;
      scheme: "ane-vault-v1" | "exact";
      network: "eip155:84532" | "eip155:31337";
      accepted: { asset: string; amount: string; payTo: string };
      payload: Record<string, unknown>;
    };
    try {
      decoded = JSON.parse(
        Buffer.from(params.paymentSignatureHeader, "base64").toString("utf8"),
      );
    } catch {
      return {
        ok: false,
        status: 400,
        code: "ANE-E-4001",
        message: "Malformed base64 JSON in PAYMENT-SIGNATURE header",
      };
    }

    const expectedResourceHash = computeResourceHash(params.method, params.canonicalUrl);
    const expectedRequestHash = computeRequestHash(params.rawBody);
    const requiredAmount = BigInt(params.endpoint.priceAmount);
    const expectedPayTo = toChecksumAddress(params.endpoint.payTo);
    const expectedAsset = toChecksumAddress(params.endpoint.assetAddress);

    if (decoded.scheme === "ane-vault-v1") {
      const p = decoded.payload as unknown as SpendIntent & {
        resourceHash?: string;
        requestHash?: string;
        signature: string;
        txHash?: string;
      };
      if (
        (p.resourceHash &&
          p.resourceHash.toLowerCase() !== expectedResourceHash.toLowerCase()) ||
        (p.requestHash && p.requestHash.toLowerCase() !== expectedRequestHash.toLowerCase())
      ) {
        return {
          ok: false,
          status: 400,
          code: "ANE-E-4006",
          message: "SpendIntent resourceHash or requestHash does not match HTTP request",
        };
      }
      if (p.merchant.toLowerCase() !== expectedPayTo.toLowerCase()) {
        return {
          ok: false,
          status: 400,
          code: "ANE-E-4007",
          message: `SpendIntent merchant (${p.merchant}) does not match merchant payTo (${expectedPayTo})`,
        };
      }
      if (BigInt(p.amount) < requiredAmount) {
        return {
          ok: false,
          status: 402,
          code: "ANE-E-4008",
          message: `SpendIntent amount (${p.amount}) is less than required (${requiredAmount})`,
        };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (Number(p.validBefore) <= nowSec) {
        return {
          ok: false,
          status: 402,
          code: "ANE-E-4003",
          message: `SpendIntent expired at ${p.validBefore} (now ${nowSec})`,
        };
      }

      const {
        structHash: intentId,
        digest,
        paymentId,
      } = hashSpendIntent(this.client.chainId, p);
      if (
        this.consumedProofs.has(intentId.toLowerCase()) ||
        this.consumedProofs.has(paymentId.toLowerCase())
      ) {
        return {
          ok: false,
          status: 409,
          code: "ANE-E-4005",
          message: `Replay detected: intentId ${intentId} already consumed`,
        };
      }

      let txHash: string;
      let blockNumber: number;

      if (p.txHash && p.txHash !== "0x" + "00".repeat(32)) {
        if (this.consumedProofs.has(p.txHash.toLowerCase())) {
          return {
            ok: false,
            status: 409,
            code: "ANE-E-4005",
            message: `Replay detected: txHash ${p.txHash} already consumed`,
          };
        }
        const check = await this.client.verifySettlementOnChain({
          txHash: p.txHash,
          expectedAsset,
          expectedPayee: expectedPayTo,
          expectedAmount: requiredAmount,
          expectedVault: p.vault,
          expectedPaymentId: paymentId,
        });
        if (!check.verified) {
          return {
            ok: false,
            status: 402,
            code: "ANE-E-4009",
            message: `Direct txHash verification failed: ${check.reason}`,
          };
        }
        txHash = p.txHash;
        blockNumber = check.blockNumber;
      } else {
        try {
          recoverAddress(digest, p.signature);
        } catch (err) {
          return {
            ok: false,
            status: 401,
            code: "ANE-E-4010",
            message: `Signature recovery error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        try {
          const settled = await this.client.settleSpendIntentOnChain(
            this.relayerKey,
            p,
            p.signature,
          );
          txHash = settled.txHash;
          blockNumber = settled.blockNumber;
        } catch (err) {
          return {
            ok: false,
            status: 402,
            code: "ANE-E-4011",
            message: `On-chain settlement reverted: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      this.consumedProofs.add(intentId.toLowerCase());
      this.consumedProofs.add(paymentId.toLowerCase());
      this.consumedProofs.add(txHash.toLowerCase());

      const receipt: X402Receipt = {
        x402Version: 2,
        success: true,
        scheme: "ane-vault-v1",
        network: decoded.network ?? "eip155:84532",
        txHash,
        blockNumber,
        intentId,
        paymentId,
        payer: toChecksumAddress(p.vault),
        payTo: expectedPayTo,
        asset: expectedAsset,
        amount: BigInt(p.amount).toString(),
        resourceHash: expectedResourceHash,
        requestHash: expectedRequestHash,
        idempotencyKey: params.idempotencyKey,
        settledAt: new Date().toISOString(),
        sponsored: false,
        disclaimer: SANDBOX_DISCLAIMER,
      };
      this.recordReceipt(receipt);
      const receiptHeaderB64 = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
      return { ok: true, receipt, receiptHeaderB64 };
    }

    if (decoded.scheme === "exact") {
      const p = decoded.payload as unknown as TransferWithAuthorization & { signature: string };
      if (p.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
        return {
          ok: false,
          status: 400,
          code: "ANE-E-4007",
          message: `Authorization recipient (${p.to}) does not match merchant payTo (${expectedPayTo})`,
        };
      }
      if (BigInt(p.value) < requiredAmount) {
        return {
          ok: false,
          status: 402,
          code: "ANE-E-4008",
          message: `Authorization value (${p.value}) is less than required (${requiredAmount})`,
        };
      }
      const { structHash, digest } = hashTransferWithAuthorization(
        this.client.chainId,
        expectedAsset,
        p,
      );
      if (this.consumedProofs.has(structHash.toLowerCase())) {
        return {
          ok: false,
          status: 409,
          code: "ANE-E-4005",
          message: "Replay detected: EIP-3009 authorization already consumed",
        };
      }
      const recovered = recoverAddress(digest, p.signature);
      if (recovered.toLowerCase() !== p.from.toLowerCase()) {
        return {
          ok: false,
          status: 401,
          code: "ANE-E-4010",
          message: "Invalid EIP-3009 signature",
        };
      }
      const settled = await this.client.settleExactAuthorizationOnChain(
        this.relayerKey,
        p,
        p.signature,
      );
      this.consumedProofs.add(structHash.toLowerCase());
      this.consumedProofs.add(settled.txHash.toLowerCase());

      const receipt: X402Receipt = {
        x402Version: 2,
        success: true,
        scheme: "exact",
        network: decoded.network ?? "eip155:84532",
        txHash: settled.txHash,
        blockNumber: settled.blockNumber,
        intentId: structHash,
        paymentId: structHash,
        payer: toChecksumAddress(p.from),
        payTo: expectedPayTo,
        asset: expectedAsset,
        amount: BigInt(p.value).toString(),
        resourceHash: expectedResourceHash,
        requestHash: expectedRequestHash,
        idempotencyKey: params.idempotencyKey,
        settledAt: new Date().toISOString(),
        sponsored: false,
        disclaimer: SANDBOX_DISCLAIMER,
      };
      this.recordReceipt(receipt);
      const receiptHeaderB64 = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
      return { ok: true, receipt, receiptHeaderB64 };
    }

    return {
      ok: false,
      status: 400,
      code: "ANE-E-4001",
      message: `Unsupported x402 scheme: ${String(decoded.scheme)}`,
    };
  }
}
