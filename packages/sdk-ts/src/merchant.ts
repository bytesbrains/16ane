import { type AneClient } from "./client.ts";
import { computeRequestHash, computeResourceHash } from "./crypto.ts";
import { build402Challenge, SANDBOX_DISCLAIMER } from "./payment-challenge.ts";
import {
  checkExactPayment,
  checkVaultPayment,
  type ExactPaymentPayload,
  type MerchantEndpointConfig,
  type VaultPaymentPayload,
  type X402DecodedPayment,
} from "./payment-checks.ts";
import { simulationFailure, vaultRegistrationFailure } from "./payment-preflight.ts";
import { type SecretKey } from "./secret.ts";
import { type KeyValueStore, MemoryKeyValueStore } from "./store.ts";
import { privateKeyToAddress, recoverAddress, toChecksumAddress } from "./secp256k1.ts";
import { type X402Receipt } from "./x402.ts";

export { SANDBOX_DISCLAIMER } from "./payment-challenge.ts";
export {
  type ExactPaymentPayload,
  type MerchantEndpointConfig,
  type PaymentBinding,
  type VaultPaymentPayload,
  type X402DecodedPayment,
} from "./payment-checks.ts";

export interface CachedIdempotentResponse {
  requestHash: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  receipt: X402Receipt;
}

export class AnePaymentVerifier {
  readonly client: AneClient;
  readonly relayerKey: SecretKey;
  // Idempotency records, consumed payment proofs and receipts. A hosted server passes a persistent store
  // (#75): losing consumed proofs on restart would let a used proof buy a service again.
  readonly store: KeyValueStore;

  constructor(params: { client: AneClient; relayerKey: SecretKey; store?: KeyValueStore }) {
    this.client = params.client;
    this.relayerKey = params.relayerKey;
    this.store = params.store ?? new MemoryKeyValueStore();
  }

  // Proofs being verified or settled right now, in this process. #reserve checks and marks synchronously,
  // before any await, so a concurrent request with the same proof is rejected (409) instead of also passing
  // the consumed check while the first is still settling. One process (one Fly.io machine) is assumed;
  // several instances sharing a store would need an atomic insert in the store instead.
  readonly #inFlight = new Set<string>();

  #consumed(id: string): boolean {
    return this.store.has("x402.proofs", id.toLowerCase());
  }

  #reserve(ids: string[]): boolean {
    const keys = ids.map((id) => id.toLowerCase());
    if (keys.some((key) => this.#inFlight.has(key) || this.#consumed(key))) return false;
    for (const key of keys) this.#inFlight.add(key);
    return true;
  }

  #release(ids: string[]): void {
    for (const id of ids) this.#inFlight.delete(id.toLowerCase());
  }

  #consume(...ids: string[]): void {
    for (const id of ids) this.store.set("x402.proofs", id.toLowerCase(), true);
  }

  getReceipt(idOrTxHash: string): X402Receipt | undefined {
    return this.store.get<X402Receipt>("x402.receipts", idOrTxHash.toLowerCase());
  }

  listReceipts(): X402Receipt[] {
    const unique = new Map<string, X402Receipt>();
    for (const r of this.store.values<X402Receipt>("x402.receipts")) {
      unique.set(r.txHash.toLowerCase(), r);
    }
    return Array.from(unique.values());
  }

  recordReceipt(receipt: X402Receipt): void {
    this.store.set("x402.receipts", receipt.txHash.toLowerCase(), receipt);
    if (receipt.intentId) {
      this.store.set("x402.receipts", receipt.intentId.toLowerCase(), receipt);
    }
    if (receipt.paymentId) {
      this.store.set("x402.receipts", receipt.paymentId.toLowerCase(), receipt);
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
    const existing = this.store.get<CachedIdempotentResponse>("x402.idempotency", idempotencyKey);
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
      this.store.set("x402.idempotency", idempotencyKey, entry);
    }
  }

  build402Challenge(
    endpoint: MerchantEndpointConfig,
    canonicalResourceUrl: string,
    trialAvailable = false,
  ): ReturnType<typeof build402Challenge> {
    return build402Challenge(endpoint, canonicalResourceUrl, trialAvailable);
  }


  /**
   * Answers "would this payment settle" without settling or consuming anything: static checks, the
   * replay read, on-chain verification for client-settled proofs, and a simulation preflight for the
   * relayer path. What backs POST /verify on a facilitator; merchants keep using verifyAndSettle.
   */
  async verifyPayment(params: {
    decoded: X402DecodedPayment;
    endpoint: MerchantEndpointConfig;
    method?: string;
    canonicalUrl?: string;
  }): Promise<
    | { valid: true; payer: string }
    | { valid: false; status: number; code: string; message: string }
  > {
    const { decoded } = params;
    const binding =
      params.method !== undefined && params.canonicalUrl !== undefined
        ? { method: params.method, canonicalUrl: params.canonicalUrl }
        : undefined;
    const expectedPayTo = toChecksumAddress(params.endpoint.payTo);
    const expectedAsset = toChecksumAddress(params.endpoint.assetAddress);
    const requiredAmount = BigInt(params.endpoint.priceAmount);

    if (decoded.scheme === "ane-vault-v1") {
      const p = decoded.payload as unknown as VaultPaymentPayload;
      const checked = checkVaultPayment(this.client.chainId, p, params.endpoint, binding);
      if (!checked.ok) return { valid: false, ...checked.failure };
      if (checked.proofIds.some((id) => this.#consumed(id))) {
        return {
          valid: false,
          status: 409,
          code: "ANE-E-4005",
          message: `Replay detected: payment proof for intentId ${checked.intentId} already used`,
        };
      }
      if (checked.directTxHash) {
        const check = await this.client.verifySettlementOnChain({
          txHash: checked.directTxHash,
          expectedAsset,
          expectedPayee: expectedPayTo,
          expectedAmount: requiredAmount,
          expectedVault: p.vault,
          expectedPaymentId: checked.paymentId,
        });
        if (!check.verified) {
          return {
            valid: false,
            status: 402,
            code: "ANE-E-4009",
            message: `Direct txHash verification failed: ${check.reason}`,
          };
        }
        return { valid: true, payer: checked.payer };
      }
      try {
        recoverAddress(checked.digest, p.signature);
      } catch {
        return { valid: false, status: 401, code: "ANE-E-4010", message: "Signature recovery failed" };
      }
      const registration = await vaultRegistrationFailure(this.client, p.vault);
      if (registration) return { valid: false, ...registration };
      const simulation = await simulationFailure(this.client, privateKeyToAddress(this.relayerKey), "ane-vault-v1", p, p.vault);
      if (simulation) return { valid: false, ...simulation };
      return { valid: true, payer: checked.payer };
    }

    if (decoded.scheme === "exact") {
      const p = decoded.payload as unknown as ExactPaymentPayload;
      const checked = checkExactPayment(this.client.chainId, p, params.endpoint);
      if (!checked.ok) return { valid: false, ...checked.failure };
      if (this.#consumed(checked.structHash)) {
        return {
          valid: false,
          status: 409,
          code: "ANE-E-4005",
          message: "Replay detected: EIP-3009 authorization already used",
        };
      }
      let recovered: string;
      try {
        recovered = recoverAddress(checked.digest, p.signature);
      } catch {
        return { valid: false, status: 401, code: "ANE-E-4010", message: "Invalid EIP-3009 signature" };
      }
      if (recovered.toLowerCase() !== p.from.toLowerCase()) {
        return { valid: false, status: 401, code: "ANE-E-4010", message: "Invalid EIP-3009 signature" };
      }
      const simulation = await simulationFailure(this.client, privateKeyToAddress(this.relayerKey), "exact", p, expectedAsset);
      if (simulation) return { valid: false, ...simulation };
      return { valid: true, payer: checked.payer };
    }

    return {
      valid: false,
      status: 400,
      code: "ANE-E-4001",
      message: `Unsupported x402 scheme: ${String(decoded.scheme)}`,
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
    // `message` is safe to send to the client; `cause` is the underlying error, for server-side logs only.
    | { ok: false; status: number; code: string; message: string; cause?: unknown }
  > {
    let decoded: X402DecodedPayment;
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
    return this.settleDecoded({
      decoded,
      endpoint: params.endpoint,
      method: params.method,
      canonicalUrl: params.canonicalUrl,
      rawBody: params.rawBody,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /**
   * verifyAndSettle for an already-decoded payment: what a facilitator calls after mapping the
   * canonical paymentPayload onto it. `preflight` adds the checks a relayer needs before spending
   * gas (registered-vault target, simulation); merchants pass none and keep byte-identical behavior.
   */
  async settleDecoded(params: {
    decoded: X402DecodedPayment;
    endpoint: MerchantEndpointConfig;
    method?: string;
    canonicalUrl?: string;
    rawBody?: string;
    idempotencyKey?: string;
    preflight?: { simulate: boolean; requireRegisteredVault: boolean };
  }): Promise<
    | { ok: true; receipt: X402Receipt; receiptHeaderB64: string }
    // `message` is safe to send to the client; `cause` is the underlying error, for server-side logs only.
    | { ok: false; status: number; code: string; message: string; cause?: unknown }
  > {
    const decoded = params.decoded;
    const binding =
      params.method !== undefined && params.canonicalUrl !== undefined
        ? { method: params.method, canonicalUrl: params.canonicalUrl, rawBody: params.rawBody }
        : undefined;

    // Unbound without a request (the facilitator settles authorizations, not requests): the receipt then
    // carries empty hashes and the merchant still checks binding at delivery.
    const expectedResourceHash = binding ? computeResourceHash(binding.method, binding.canonicalUrl) : "";
    const expectedRequestHash = binding ? computeRequestHash(binding.rawBody) : "";
    const requiredAmount = BigInt(params.endpoint.priceAmount);
    const expectedPayTo = toChecksumAddress(params.endpoint.payTo);
    const expectedAsset = toChecksumAddress(params.endpoint.assetAddress);

    if (decoded.scheme === "ane-vault-v1") {
      const p = decoded.payload as unknown as VaultPaymentPayload;
      const checked = checkVaultPayment(this.client.chainId, p, params.endpoint, binding);
      if (!checked.ok) {
        return { ok: false, ...checked.failure };
      }
      const { intentId, digest, paymentId, directTxHash, proofIds } = checked;
      if (!this.#reserve(proofIds)) {
        return {
          ok: false,
          status: 409,
          code: "ANE-E-4005",
          message: `Replay detected: payment proof for intentId ${intentId} already used or in use`,
        };
      }

      try {
        let txHash: string;
        let blockNumber: number;

        if (directTxHash) {
          const check = await this.client.verifySettlementOnChain({
            txHash: directTxHash,
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
          txHash = directTxHash;
          blockNumber = check.blockNumber;
        } else {
          try {
            recoverAddress(digest, p.signature);
          } catch (err) {
            return {
              ok: false,
              status: 401,
              code: "ANE-E-4010",
              message: "Signature recovery failed",
              cause: err,
            };
          }

          if (params.preflight?.requireRegisteredVault) {
            const registration = await vaultRegistrationFailure(this.client, p.vault);
            if (registration) return { ok: false, ...registration };
          }
          if (params.preflight?.simulate) {
            const simulation = await simulationFailure(this.client, privateKeyToAddress(this.relayerKey), "ane-vault-v1", p, p.vault);
            if (simulation) return { ok: false, ...simulation };
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
              message: "On-chain settlement failed",
              cause: err,
            };
          }
        }

        this.#consume(intentId, paymentId, txHash);

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
      } finally {
        this.#release(proofIds);
      }
    }

    if (decoded.scheme === "exact") {
      const p = decoded.payload as unknown as ExactPaymentPayload;
      const checked = checkExactPayment(this.client.chainId, p, params.endpoint);
      if (!checked.ok) {
        return { ok: false, ...checked.failure };
      }
      const { structHash, digest } = checked;
      if (!this.#reserve([structHash])) {
        return {
          ok: false,
          status: 409,
          code: "ANE-E-4005",
          message: "Replay detected: EIP-3009 authorization already used or in use",
        };
      }
      try {
        let recovered: string;
        try {
          recovered = recoverAddress(digest, p.signature);
        } catch {
          return {
            ok: false,
            status: 401,
            code: "ANE-E-4010",
            message: "Invalid EIP-3009 signature",
          };
        }
        if (recovered.toLowerCase() !== p.from.toLowerCase()) {
          return {
            ok: false,
            status: 401,
            code: "ANE-E-4010",
            message: "Invalid EIP-3009 signature",
          };
        }
        if (params.preflight?.simulate) {
          const simulation = await simulationFailure(this.client, privateKeyToAddress(this.relayerKey), "exact", p, expectedAsset);
          if (simulation) return { ok: false, ...simulation };
        }
        const settled = await this.client.settleExactAuthorizationOnChain(
          this.relayerKey,
          p,
          p.signature,
        );
        this.#consume(structHash, settled.txHash);

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
      } finally {
        this.#release([structHash]);
      }
    }

    return {
      ok: false,
      status: 400,
      code: "ANE-E-4001",
      message: `Unsupported x402 scheme: ${String(decoded.scheme)}`,
    };
  }
}
