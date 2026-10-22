import { abiWordAddress, functionSelector } from "./abi.ts";
import { type AneClient } from "./client.ts";
import {
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  hashTransferWithAuthorization,
  randomBytes32Hex,
  type SpendIntent,
  type TransferWithAuthorization,
} from "./crypto.ts";
import { type SecretKey } from "./secret.ts";
import { settlePaymentCalldata, transferCalldata } from "./signed-actions.ts";
import { type KeyValueStore, MemoryKeyValueStore } from "./store.ts";
import { privateKeyToAddress, recoverAddress, toChecksumAddress } from "./secp256k1.ts";
import {
  type X402PaymentRequirements,
  type X402QuoteEnvelope,
  type X402Receipt,
} from "./x402.ts";

export const SANDBOX_DISCLAIMER = "TEST TOKENS (tANE) - NO CASH VALUE" as const;

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

  // Static (chain-free) checks for an ane-vault-v1 payload, shared by merchants and the facilitator so
  // verify and settle can never disagree on validity. Request binding applies only when the caller passes
  // what the payment binds to; merchants always do, a facilitator has no request to bind.
  #checkVaultPayment(
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
    } = hashSpendIntent(this.client.chainId, p);
    const directTxHash = p.txHash && p.txHash !== "0x" + "00".repeat(32) ? p.txHash : undefined;
    const proofIds = directTxHash ? [intentId, paymentId, directTxHash] : [intentId, paymentId];
    return { ok: true, intentId, digest, paymentId, directTxHash, payer: toChecksumAddress(p.vault), proofIds };
  }

  // Static checks for an exact (EIP-3009) payload. Time bounds and funds are enforced where the
  // authorization executes: on-chain at settle, or by simulation in verify-only and preflight.
  #checkExactPayment(
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
      this.client.chainId,
      expectedAsset,
      p,
    );
    return { ok: true, structHash, digest, payer: toChecksumAddress(p.from) };
  }

  // The settlement target allowlist (#18): a vault intent settles only to a vault the 16ane factory
  // registered. A send to any other address would succeed vacuously on-chain while settling nothing.
  async #vaultRegistrationFailure(vault: string): Promise<{ status: number; code: string; message: string } | undefined> {
    const { aneVaultFactory } = await this.client.resolveContracts();
    const registered = await this.client.ethCall(
      aneVaultFactory,
      functionSelector("isRegisteredVault(address)") + abiWordAddress(vault),
    );
    if (BigInt(registered.slice(0, 66)) === 0n) {
      return {
        status: 403,
        code: "ANE-E-4013",
        message: `${vault} is not a vault created by the 16ane factory`,
      };
    }
    return undefined;
  }

  // Would the relayer's send succeed? Simulation runs the exact settlement from the relayer's address
  // without spending gas, so an underfunded, expired or already-used authorization is refused up front.
  async #simulationFailure(
    scheme: "ane-vault-v1" | "exact",
    p: VaultPaymentPayload | ExactPaymentPayload,
    to: string,
  ): Promise<{ status: number; code: string; message: string } | undefined> {
    const data =
      scheme === "ane-vault-v1"
        ? settlePaymentCalldata(p as VaultPaymentPayload, (p as VaultPaymentPayload).signature)
        : transferCalldata(p as ExactPaymentPayload);
    try {
      await this.client.simulateCall(privateKeyToAddress(this.relayerKey), to, data);
    } catch (err) {
      // A fetch-level failure (DNS, refused, reset) is the chain being unreachable, not a bad
      // payment: let it surface as a 500 "cannot evaluate" instead of a 402 rejection. An EVM
      // revert always arrives as an RPC error payload, never as a TypeError.
      if (err instanceof TypeError) throw err;
      const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return { status: 402, code: "ANE-E-4011", message: `Settlement would revert, so nothing was sent: ${why}` };
    }
    return undefined;
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
      const checked = this.#checkVaultPayment(p, params.endpoint, binding);
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
      const registration = await this.#vaultRegistrationFailure(p.vault);
      if (registration) return { valid: false, ...registration };
      const simulation = await this.#simulationFailure("ane-vault-v1", p, p.vault);
      if (simulation) return { valid: false, ...simulation };
      return { valid: true, payer: checked.payer };
    }

    if (decoded.scheme === "exact") {
      const p = decoded.payload as unknown as ExactPaymentPayload;
      const checked = this.#checkExactPayment(p, params.endpoint);
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
      const simulation = await this.#simulationFailure("exact", p, expectedAsset);
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
    const expectedResourceHash =
      params.method !== undefined && params.canonicalUrl !== undefined
        ? computeResourceHash(params.method, params.canonicalUrl)
        : "";
    const expectedRequestHash =
      params.method !== undefined && params.canonicalUrl !== undefined
        ? computeRequestHash(params.rawBody)
        : "";
    const requiredAmount = BigInt(params.endpoint.priceAmount);
    const expectedPayTo = toChecksumAddress(params.endpoint.payTo);
    const expectedAsset = toChecksumAddress(params.endpoint.assetAddress);

    if (decoded.scheme === "ane-vault-v1") {
      const p = decoded.payload as unknown as VaultPaymentPayload;
      const checked = this.#checkVaultPayment(p, params.endpoint, binding);
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
            const registration = await this.#vaultRegistrationFailure(p.vault);
            if (registration) return { ok: false, ...registration };
          }
          if (params.preflight?.simulate) {
            const simulation = await this.#simulationFailure("ane-vault-v1", p, p.vault);
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
      const checked = this.#checkExactPayment(p, params.endpoint);
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
          const simulation = await this.#simulationFailure("exact", p, expectedAsset);
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
