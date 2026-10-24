import util from "node:util";
import { type AneClient } from "./client.ts";
import {
  computePaymentId,
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  randomBytes32Hex,
  type ServiceManifestPayload,
  type SpendIntent,
} from "./crypto.ts";
import { keccak256Utf8 } from "./keccak.ts";
import {
  probeOffer,
  routeOffers,
  selectRequirement,
  type AcceptedAsset,
  type ProviderOffer,
  type RankedOffer,
  type RouteResult,
} from "./routing.ts";
import { REDACTED_PRIVATE_KEY, SecretKey } from "./secret.ts";
import { privateKeyToAddress, signDigest, toChecksumAddress } from "./secp256k1.ts";
import {
  type PurchaseOptions,
  type PurchaseResult,
  type X402QuoteEnvelope,
  type X402Receipt,
} from "./x402.ts";

/** A provider to ask for a quote before choosing whom to buy from. */
export interface ProviderCandidate {
  url: string;
  providerId?: string;
  method?: PurchaseOptions["method"];
  headers?: Record<string, string>;
  body?: string;
  /** The caller's own measurement, e.g. from past purchases; replaces the probe's quote round trip. */
  latencyMs?: number;
}

export class AgentSession {
  readonly client: AneClient;
  readonly vaultAddress: string;
  readonly sessionAddress: string;
  #sessionKey: SecretKey;
  #vaultAsset?: Promise<string>;

  constructor(params: {
    client: AneClient;
    vaultAddress: string;
    sessionKey: string | SecretKey;
  }) {
    this.client = params.client;
    this.vaultAddress = toChecksumAddress(params.vaultAddress);
    this.#sessionKey =
      params.sessionKey instanceof SecretKey
        ? params.sessionKey
        : new SecretKey(params.sessionKey);
    this.sessionAddress = privateKeyToAddress(this.#sessionKey);
  }

  toJSON(): Record<string, unknown> {
    return {
      vaultAddress: this.vaultAddress,
      sessionAddress: this.sessionAddress,
      sessionKey: REDACTED_PRIVATE_KEY,
    };
  }

  [util.inspect.custom](): string {
    return `AgentSession(vault=${this.vaultAddress}, session=${this.sessionAddress}, key=${REDACTED_PRIVATE_KEY})`;
  }

  signSpendIntent(params: {
    merchant: string;
    amount: bigint | string;
    quoteId: string;
    serviceIdHash: string;
    nonce?: string;
    validAfter?: number;
    validBefore: number;
    policyVersion?: number;
  }): { intent: SpendIntent; signature: string; intentId: string; paymentId: string } {
    const intent: SpendIntent = {
      vault: this.vaultAddress,
      merchant: toChecksumAddress(params.merchant),
      amount: BigInt(params.amount).toString(),
      quoteId: params.quoteId,
      serviceIdHash: params.serviceIdHash,
      validAfter: params.validAfter ?? 0,
      validBefore: params.validBefore,
      nonce: params.nonce ?? randomBytes32Hex(),
      policyVersion: params.policyVersion ?? 1,
    };
    const { structHash, digest, paymentId } = hashSpendIntent(this.client.chainId, intent);
    const sig = signDigest(digest, this.#sessionKey);
    return {
      intent,
      signature: sig.serialized,
      intentId: structHash,
      paymentId,
    };
  }

  async settleDirectSpend(params: {
    merchant: string;
    amount: bigint | string;
    quoteId: string;
    serviceIdHash: string;
    nonce?: string;
  }): Promise<{ txHash: string; blockNumber: number; paymentId: string; nonce: string }> {
    const nonce = params.nonce ?? randomBytes32Hex();
    const res = await this.client.sendContractTx(
      this.#sessionKey,
      this.vaultAddress,
      "spend(address,uint256,bytes32,bytes32,bytes32)",
      [
        toChecksumAddress(params.merchant),
        BigInt(params.amount).toString(),
        params.quoteId,
        params.serviceIdHash,
        nonce,
      ],
    );
    const paymentId = computePaymentId(
      this.client.chainId,
      this.vaultAddress,
      toChecksumAddress(params.merchant),
      params.quoteId,
      nonce,
    );
    return {
      txHash: res.txHash,
      blockNumber: res.blockNumber,
      paymentId,
      nonce,
    };
  }

  /** The one token this vault can pay in (`AneAgentVault.taneToken`), read once from the vault itself. */
  vaultAsset(): Promise<string> {
    if (this.#vaultAsset) return this.#vaultAsset;
    const vaultAsset = this.client.getVaultAsset(this.vaultAddress);
    // Forget only this read if it fails: a retry started meanwhile is newer and stays cached.
    vaultAsset.catch(() => {
      if (this.#vaultAsset === vaultAsset) this.#vaultAsset = undefined;
    });
    return (this.#vaultAsset = vaultAsset);
  }

  /**
   * Asks each candidate for a quote without paying, then ranks the offers this vault can pay (ADR-0019): its own
   * token on this chain, at or under `maxPayment`, within `maxLatencyMs` of measured quote latency.
   */
  async chooseProvider(
    candidates: ProviderCandidate[],
    constraints: { maxPayment: bigint | string; maxLatencyMs?: number; prefer?: "price" | "latency" },
  ): Promise<RouteResult> {
    const asset: AcceptedAsset = {
      chainId: this.client.chainId,
      asset: await this.vaultAsset(),
      maxAmount: BigInt(constraints.maxPayment),
    };
    const offers = await this.probeProviders(candidates);
    return routeOffers(offers, {
      assets: [asset],
      maxLatencyMs: constraints.maxLatencyMs,
      prefer: constraints.prefer,
    });
  }

  /** Asks each candidate for a quote without paying (`probeOffer`), identifying this vault and session. */
  probeProviders(candidates: ProviderCandidate[]): Promise<ProviderOffer[]> {
    return Promise.all(
      candidates.map(async (c) => {
        const offer = await probeOffer(c.url, {
          providerId: c.providerId,
          method: c.method,
          headers: { "x-agent-vault": this.vaultAddress, "x-agent-session": this.sessionAddress, ...c.headers },
          body: c.body,
        });
        return c.latencyMs === undefined ? offer : { ...offer, latencyMs: c.latencyMs };
      }),
    );
  }

  /**
   * Buys from a routed offer, pinned to it: the purchase refuses a fresh quote that costs more or pays someone
   * else, so a provider cannot win the ranking with one quote and charge another.
   */
  purchaseRouted<T = unknown>(
    chosen: RankedOffer,
    options: Omit<PurchaseOptions, "maxPayment" | "expectedPayTo"> = {},
  ): Promise<PurchaseResult<T>> {
    return this.purchase<T>(chosen.url, {
      ...options,
      maxPayment: chosen.amount,
      expectedPayTo: chosen.requirement.payTo,
    });
  }

  async purchase<T = unknown>(
    url: string,
    options: PurchaseOptions = {},
  ): Promise<PurchaseResult<T>> {
    const method = options.method ?? (options.body ? "POST" : "GET");
    const idempotencyKey = options.idempotencyKey ?? `idem-${randomBytes32Hex().slice(2, 34)}`;
    const baseHeaders: Record<string, string> = {
      ...(options.body ? { "content-type": "application/json" } : {}),
      "x-agent-vault": this.vaultAddress,
      "x-agent-session": this.sessionAddress,
      "idempotency-key": idempotencyKey,
      ...(options.headers ?? {}),
    };

    const initialRes = await fetch(url, {
      method,
      headers: baseHeaders,
      body: options.body,
    });

    const extractHeaders = (res: Response): Record<string, string> => {
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return out;
    };

    if (initialRes.status !== 402) {
      const text = await initialRes.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON response
      }
      const resHeaders = extractHeaders(initialRes);
      const paymentResponseHeader = resHeaders["payment-response"];
      let receipt: X402Receipt | undefined;
      if (paymentResponseHeader) {
        receipt = JSON.parse(
          Buffer.from(paymentResponseHeader, "base64").toString("utf8"),
        ) as X402Receipt;
      }
      const trialRemainingHeader = resHeaders["x-trial-quota-remaining"];
      return {
        status: initialRes.status,
        data: parsed as T,
        receipt,
        trialSponsored: Boolean(receipt?.sponsored || trialRemainingHeader !== undefined),
        trialRemaining:
          trialRemainingHeader !== undefined ? Number(trialRemainingHeader) : undefined,
        headers: resHeaders,
      };
    }

    const paymentRequiredB64 = initialRes.headers.get("payment-required");
    if (!paymentRequiredB64) {
      throw new Error("402 response missing PAYMENT-REQUIRED header");
    }
    const quoteEnvelope = JSON.parse(
      Buffer.from(paymentRequiredB64, "base64").toString("utf8"),
    ) as X402QuoteEnvelope;

    // The vault pays only its own token, so only a quote in that token on this chain is payable; an amount
    // quoted in any other asset would be read in the wrong units (ADR-0019).
    const vaultAsset = await this.vaultAsset();
    const { match, rejected } = selectRequirement(quoteEnvelope?.accepts, [
      { chainId: this.client.chainId, asset: vaultAsset, maxAmount: (1n << 256n) - 1n },
    ]);
    if (!match) {
      throw new Error(
        `ANE-E-3003: No 402 quote is payable from this vault (tANE ${vaultAsset} on eip155:${this.client.chainId}): ${rejected.join("; ")}`,
      );
    }
    const requirement = match.requirement;
    if (options.expectedPayTo !== undefined && requirement.payTo !== toChecksumAddress(options.expectedPayTo)) {
      throw new Error(`ANE-E-5003: 402 payTo ${requirement.payTo} is not the expected ${options.expectedPayTo}`);
    }

    const requiredAmount = match.amount;
    if (options.maxPayment !== undefined && requiredAmount > BigInt(options.maxPayment)) {
      throw new Error(
        `ANE-E-3002: Quote amount ${requiredAmount} exceeds caller maxPayment ${BigInt(options.maxPayment)}`,
      );
    }

    let manifest = options.manifest;
    if (!manifest && options.verifyManifest) {
      const origin = new URL(url).origin;
      const manifestRes = await fetch(`${origin}/.well-known/16ane-service.json`);
      if (!manifestRes.ok) {
        throw new Error(`ANE-E-5001: Failed to fetch service manifest from ${origin}`);
      }
      manifest = (await manifestRes.json()) as ServiceManifestPayload;
    }

    if (manifest) {
      const contracts = await this.client.resolveContracts();
      const verification = this.client.verifyServiceManifest(
        manifest,
        contracts.aneServiceDirectory,
      );
      if (!verification.valid) {
        throw new Error(`ANE-E-5002: Invalid service manifest signature: ${verification.reason}`);
      }
      if (manifest.payTo.toLowerCase() !== requirement.payTo.toLowerCase()) {
        throw new Error(
          `ANE-E-5003: Spoofed 402 payTo (${requirement.payTo}) does not match signed manifest payTo (${manifest.payTo})`,
        );
      }
    }

    const summary = await this.client.getAccountingSummary(this.vaultAddress);
    if (!summary.active || summary.spendableNow < requiredAmount) {
      throw new Error(
        `ANE-E-3001: Insufficient available session allowance (${summary.spendableNow} < ${requiredAmount})`,
      );
    }

    const resourceHash = computeResourceHash(method, url);
    const requestHash = computeRequestHash(options.body);
    const quoteIdB32 = keccak256Utf8(
      `${requirement.extra?.quoteId ?? idempotencyKey}:${resourceHash}:${requestHash}`,
    );
    const serviceIdHash = keccak256Utf8(
      requirement.extra?.serviceId ?? "16ane-sandbox-reference-demo",
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const validBefore =
      requirement.extra?.expiresAt ?? nowSec + (requirement.maxTimeoutSeconds || 300);

    let payload: Record<string, unknown>;

    if (options.settleDirectOnChain) {
      const direct = await this.settleDirectSpend({
        merchant: requirement.payTo,
        amount: requiredAmount,
        quoteId: quoteIdB32,
        serviceIdHash,
      });
      payload = {
        vault: this.vaultAddress,
        merchant: toChecksumAddress(requirement.payTo),
        amount: requiredAmount.toString(),
        quoteId: quoteIdB32,
        serviceIdHash,
        validAfter: 0,
        validBefore,
        nonce: direct.nonce,
        policyVersion: summary.policyVersion,
        resourceHash,
        requestHash,
        signature: "0x" + "00".repeat(65),
        txHash: direct.txHash,
      };
    } else {
      const signed = this.signSpendIntent({
        merchant: requirement.payTo,
        amount: requiredAmount,
        quoteId: quoteIdB32,
        serviceIdHash,
        validBefore,
        policyVersion: summary.policyVersion,
      });
      payload = {
        ...signed.intent,
        resourceHash,
        requestHash,
        signature: signed.signature,
      };
    }

    const paymentPayload = {
      x402Version: 2,
      scheme: "ane-vault-v1",
      network: requirement.network,
      accepted: {
        asset: requirement.asset,
        amount: requirement.amount,
        payTo: requirement.payTo,
      },
      payload,
    };

    const paymentSignatureB64 = Buffer.from(JSON.stringify(paymentPayload), "utf8").toString(
      "base64",
    );

    const paidRes = await fetch(url, {
      method,
      headers: {
        ...baseHeaders,
        "payment-signature": paymentSignatureB64,
      },
      body: options.body,
    });

    const paidHeaders = extractHeaders(paidRes);
    const paidText = await paidRes.text();
    let paidData: unknown = paidText;
    try {
      paidData = JSON.parse(paidText);
    } catch {
      // non-JSON
    }

    let receipt: X402Receipt | undefined;
    if (paidHeaders["payment-response"]) {
      receipt = JSON.parse(
        Buffer.from(paidHeaders["payment-response"], "base64").toString("utf8"),
      ) as X402Receipt;
    }

    if (paidRes.ok && receipt && options.verifyReceiptOnChain && !receipt.sponsored) {
      const check = await this.client.verifySettlementOnChain({
        txHash: receipt.txHash,
        expectedAsset: vaultAsset,
        expectedPayee: receipt.payTo,
        expectedAmount: receipt.amount,
        expectedVault: this.vaultAddress,
        expectedPaymentId: receipt.paymentId,
      });
      if (!check.verified) {
        throw new Error(`ANE-E-4009: On-chain receipt verification failed: ${check.reason}`);
      }
    }

    return {
      status: paidRes.status,
      data: paidData as T,
      receipt,
      trialSponsored: false,
      headers: paidHeaders,
    };
  }
}
