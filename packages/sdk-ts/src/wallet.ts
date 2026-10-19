import util from "node:util";
import {
  BUDGET_MODE,
  normalizeSaltBytes32,
  type AneClient,
  type BudgetModeName,
} from "./client.ts";
import {
  computePaymentId,
  computeRequestHash,
  computeResourceHash,
  hashSpendIntent,
  keccak256Utf8,
  privateKeyToAddress,
  randomBytes32Hex,
  signDigest,
  toChecksumAddress,
  type ServiceManifestPayload,
  type SpendIntent,
} from "./crypto.ts";
import { REDACTED_PRIVATE_KEY, SecretKey } from "./secret.ts";

export interface DelegatePolicyInput {
  mode?: BudgetModeName;
  allowanceCap: bigint | string;
  perTxLimit: bigint | string;
  dailyLimit?: bigint | string;
  expiry: number;
  revolvingTreasuryCeiling?: bigint | string;
}

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
  disclaimer: string;
}

export interface PurchaseOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  maxPayment?: bigint | string;
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

export class OwnerWallet {
  readonly client: AneClient;
  readonly address: string;
  #secretKey: SecretKey;

  constructor(client: AneClient, privateKey: string | SecretKey) {
    this.client = client;
    this.#secretKey = privateKey instanceof SecretKey ? privateKey : new SecretKey(privateKey);
    this.address = privateKeyToAddress(this.#secretKey);
  }

  toJSON(): Record<string, unknown> {
    return { address: this.address, secretKey: REDACTED_PRIVATE_KEY };
  }

  [util.inspect.custom](): string {
    return `OwnerWallet(address=${this.address}, secretKey=${REDACTED_PRIVATE_KEY})`;
  }

  async ensureVaultDeployed(
    salt: bigint | number | string = 0n,
  ): Promise<{ vaultAddress: string; txHash?: string }> {
    const saltB32 = normalizeSaltBytes32(salt);
    const vaultAddress = await this.client.computeVaultAddress(this.address, saltB32);
    const deployed = await this.client.isContractDeployed(vaultAddress);
    if (deployed) {
      return { vaultAddress };
    }
    const { aneVaultFactory } = await this.client.resolveContracts();
    const res = await this.client.sendContractTx(
      this.#secretKey,
      aneVaultFactory,
      "createVault(address,bytes32)",
      [this.address, saltB32],
    );
    return { vaultAddress, txHash: res.txHash };
  }

  async fundVault(
    vaultAddress: string,
    amount: bigint | string,
  ): Promise<{ approveTxHash: string; depositTxHash: string }> {
    const { aneTestToken } = await this.client.resolveContracts();
    const approveRes = await this.client.sendContractTx(
      this.#secretKey,
      aneTestToken,
      "approve(address,uint256)",
      [vaultAddress, amount.toString()],
    );
    const depositRes = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "fund(uint256)",
      [amount.toString()],
    );
    return {
      approveTxHash: approveRes.txHash,
      depositTxHash: depositRes.txHash,
    };
  }

  async delegateSession(
    vaultAddress: string,
    sessionAddress: string,
    policy: DelegatePolicyInput,
  ): Promise<{ txHash: string }> {
    const modeEnum = policy.mode === "REVOLVING" ? BUDGET_MODE.REVOLVING : BUDGET_MODE.FIXED;
    const maxTotal = BigInt(policy.allowanceCap).toString();
    const maxPerTx = BigInt(policy.perTxLimit).toString();
    const dailyLimit = BigInt(policy.dailyLimit ?? policy.allowanceCap).toString();
    const revolvingCeiling = BigInt(
      policy.revolvingTreasuryCeiling ?? policy.allowanceCap,
    ).toString();
    const tupleArg = `(${toChecksumAddress(sessionAddress)},${maxTotal},${maxPerTx},${dailyLimit},${policy.expiry},${modeEnum},${revolvingCeiling})`;
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "setPolicy((address,uint256,uint256,uint256,uint64,uint8,uint256))",
      [tupleArg],
    );
    return { txHash: res.txHash };
  }

  async revokeSession(vaultAddress: string): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "revoke()",
      [],
    );
    return { txHash: res.txHash };
  }

  async revokeAndSweep(
    vaultAddress: string,
    _sessionAddress: string,
    recipient: string,
  ): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "revokeAndSweep(address)",
      [toChecksumAddress(recipient)],
    );
    return { txHash: res.txHash };
  }

  async withdrawPrincipal(
    vaultAddress: string,
    to: string,
    amount: bigint | string,
  ): Promise<{ txHash: string }> {
    const res = await this.client.sendContractTx(
      this.#secretKey,
      vaultAddress,
      "withdraw(uint256,address)",
      [BigInt(amount).toString(), toChecksumAddress(to)],
    );
    return { txHash: res.txHash };
  }
}

export class AgentSession {
  readonly client: AneClient;
  readonly vaultAddress: string;
  readonly sessionAddress: string;
  #sessionKey: SecretKey;

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

    const requirement =
      quoteEnvelope.accepts.find((a) => a.scheme === "ane-vault-v1") ?? quoteEnvelope.accepts[0];
    if (!requirement) {
      throw new Error("No compatible payment scheme in 402 PAYMENT-REQUIRED");
    }

    const requiredAmount = BigInt(requirement.amount);
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

    let paymentPayload: Record<string, unknown>;

    if (options.settleDirectOnChain) {
      const direct = await this.settleDirectSpend({
        merchant: requirement.payTo,
        amount: requiredAmount,
        quoteId: quoteIdB32,
        serviceIdHash,
      });
      paymentPayload = {
        x402Version: 2,
        scheme: "ane-vault-v1",
        network: requirement.network,
        accepted: {
          asset: requirement.asset,
          amount: requirement.amount,
          payTo: requirement.payTo,
        },
        payload: {
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
        },
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
      paymentPayload = {
        x402Version: 2,
        scheme: "ane-vault-v1",
        network: requirement.network,
        accepted: {
          asset: requirement.asset,
          amount: requirement.amount,
          payTo: requirement.payTo,
        },
        payload: {
          ...signed.intent,
          resourceHash,
          requestHash,
          signature: signed.signature,
        },
      };
    }

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
        expectedAsset: receipt.asset,
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
