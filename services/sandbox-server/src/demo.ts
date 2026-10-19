import http from "node:http";
import crypto from "node:crypto";
import {
  AneClient,
  AnePaymentVerifier,
  computeRequestHash,
  keccak256Utf8,
  SANDBOX_DISCLAIMER,
  SecretKey,
  toChecksumAddress,
  TrialQuotaTracker,
  type AneContractAddresses,
  type MerchantEndpointConfig,
  type ServiceManifestPayload,
  type X402Receipt,
} from "../../../packages/sdk-ts/src/index.ts";
import { clientIp, readRequestBody, sendError, sendJson } from "./http.ts";

const ONE_TANE = 10n ** 18n;
const PRICE_SUMMARIZE = 16n * ONE_TANE; // 16 tANE (= 1 simulated INR)
const PRICE_CLEAN_DATA = 32n * ONE_TANE; // 32 tANE (= 2 simulated INR)
const PRICE_SIMULATE_FAILURE = 16n * ONE_TANE; // 16 tANE

const DEMO_SERVICE_ID = "16ane-sandbox-reference-demo";

const PRICE_BY_PATH: Record<string, bigint> = {
  "/v1/demo/summarize": PRICE_SUMMARIZE,
  "/v1/demo/clean-data": PRICE_CLEAN_DATA,
  "/v1/demo/simulate-failure": PRICE_SIMULATE_FAILURE,
};

export interface DemoContext {
  client: AneClient;
  verifier: AnePaymentVerifier;
  trialTracker: TrialQuotaTracker;
  providerKey: SecretKey;
  providerAddress: string;
  contracts: AneContractAddresses;
  trustProxy: boolean;
  maxBodyBytes: number;
}

export function isDemoRoute(method: string, pathname: string): boolean {
  return method === "POST" && Object.hasOwn(PRICE_BY_PATH, pathname);
}

export function buildDemoManifest(
  ctx: DemoContext,
  chainId: number,
): Omit<ServiceManifestPayload, "signer" | "signature"> {
  const { trialTracker } = ctx;
  return {
    schemaVersion: "16ane-manifest-v0",
    serviceId: DEMO_SERVICE_ID,
    name: "16ane Deterministic Reference Paid Services (Sandbox)",
    description:
      "Reference x402 v2 paid agent endpoints settling in simulated tANE (TEST TOKENS - NO CASH VALUE)",
    version: "0.1.0",
    network: "eip155:84532",
    chainId,
    payTo: ctx.providerAddress,
    tokenAddress: ctx.contracts.aneTestToken,
    tokenSymbol: "tANE",
    updatedAt: 1760860800,
    endpoints: [
      {
        id: "summarize",
        method: "POST",
        path: "/v1/demo/summarize",
        priceAmount: PRICE_SUMMARIZE.toString(),
        scheme: "ane-vault-v1",
        description: "Deterministic text summarization (16 tANE per call)",
      },
      {
        id: "clean-data",
        method: "POST",
        path: "/v1/demo/clean-data",
        priceAmount: PRICE_CLEAN_DATA.toString(),
        scheme: "ane-vault-v1",
        description: "Deterministic JSON array deduplication and normalization (32 tANE per call)",
      },
      {
        id: "simulate-failure",
        method: "POST",
        path: "/v1/demo/simulate-failure",
        priceAmount: PRICE_SIMULATE_FAILURE.toString(),
        scheme: "ane-vault-v1",
        description:
          "Settles 16 tANE and simulates downstream failure with automatic on-chain refundPayment",
      },
    ],
    trialQuota: {
      enabled: true,
      freeCallsPerCaller: trialTracker.config.freeCallsPerCaller,
      globalDailyCap: trialTracker.config.globalDailyCap,
      sponsorDisclosure:
        trialTracker.config.sponsorDisclosure ??
        "Provider-sponsored sandbox trial (0 tANE charged)",
    },
  };
}

function summarize(rawBody: string): { summary: string; wordCount: number; contentSha256: string } {
  const parsedInput = rawBody ? (JSON.parse(rawBody) as { text?: string }) : { text: "" };
  const text = parsedInput.text ?? "";
  const words = text.trim() ? text.trim().split(/\s+/) : [];
  return {
    summary: words.slice(0, 12).join(" "),
    wordCount: words.length,
    contentSha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function cleanData(rawBody: string): { inputCount: number; outputCount: number; items: string[] } {
  const parsedInput = rawBody ? (JSON.parse(rawBody) as { items?: string[] }) : { items: [] };
  const items = Array.isArray(parsedInput.items) ? parsedInput.items : [];
  const normalized = Array.from(
    new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean)),
  ).sort();
  return { inputCount: items.length, outputCount: normalized.length, items: normalized };
}

// Reference paid demo endpoints (/v1/demo/*): idempotency, sponsored trial, x402 settlement.
export async function handleDemoRequest(
  ctx: DemoContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  pathname: string,
  fullUrl: URL,
): Promise<void> {
  const { client, verifier, trialTracker, providerKey, providerAddress, contracts } = ctx;
  const rawBody = await readRequestBody(req, ctx.maxBodyBytes);
  const requestHash = computeRequestHash(rawBody);
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

  // Check Idempotency-Key first (ADR-0009)
  const idem = verifier.checkIdempotency(idempotencyKey, requestHash);
  if (idem.status === "CONFLICT") {
    sendError(res, 409, "ANE-E-4004", idem.message, false);
    return;
  }
  if (idem.status === "HIT") {
    sendJson(res, idem.cached.status, idem.cached.body, {
      ...idem.cached.headers,
      "x-idempotent-replay": "true",
    });
    return;
  }

  const endpointConfig: MerchantEndpointConfig = {
    serviceId: DEMO_SERVICE_ID,
    priceAmount: PRICE_BY_PATH[pathname],
    payTo: providerAddress,
    assetAddress: contracts.aneTestToken,
    network: "eip155:84532",
    description: `16ane Sandbox Demo (${pathname})`,
  };

  const paymentSignatureHeader = req.headers["payment-signature"] as string | undefined;
  const trialRequested = req.headers["x-trial-request"] === "true";
  // Trial quota is keyed on the network address: the vault/session headers are unauthenticated
  // and rotating them must not mint extra sponsored calls (#31).
  const trialQuotaKey = clientIp(req, ctx.trustProxy);
  const claimedVault = (req.headers["x-agent-vault"] as string | undefined) ?? "";

  // If no PAYMENT-SIGNATURE header, check if a provider-sponsored trial call was requested
  if (!paymentSignatureHeader) {
    if (pathname === "/v1/demo/summarize" && trialRequested) {
      const trial = trialTracker.checkAndConsume(trialQuotaKey);
      if (trial.allowed) {
        const trialReceipt: X402Receipt = {
          x402Version: 2,
          success: true,
          scheme: "sponsored-trial",
          network: "eip155:84532",
          txHash: "0x" + "00".repeat(32),
          blockNumber: 0,
          payer: toChecksumAddress(
            /^0x[0-9a-fA-F]{40}$/.test(claimedVault)
              ? claimedVault
              : "0x0000000000000000000000000000000000000000",
          ),
          payTo: providerAddress,
          asset: contracts.aneTestToken,
          amount: "0",
          resourceHash: keccak256Utf8(`${method}:${fullUrl.toString()}`),
          requestHash,
          idempotencyKey,
          settledAt: new Date().toISOString(),
          sponsored: true,
          disclaimer: `${SANDBOX_DISCLAIMER} — ${trial.disclosure}`,
        };
        const receiptHeaderB64 = Buffer.from(JSON.stringify(trialReceipt), "utf8").toString(
          "base64",
        );
        sendJson(
          res,
          200,
          {
            serviceId: DEMO_SERVICE_ID,
            endpoint: pathname,
            ...summarize(rawBody),
            sponsored: true,
            sponsorDisclosure: trial.disclosure,
            trialQuotaRemaining: trial.remainingCallerQuota,
            disclaimer: SANDBOX_DISCLAIMER,
          },
          {
            "payment-response": receiptHeaderB64,
            "x-trial-quota-remaining": trial.remainingCallerQuota.toString(),
          },
        );
        return;
      }
    }

    const challenge = verifier.build402Challenge(
      endpointConfig,
      fullUrl.toString(),
      pathname === "/v1/demo/summarize",
    );
    sendJson(res, challenge.status, challenge.body, challenge.headers);
    return;
  }

  // Verify and settle the x402 payment proof
  const settled = await verifier.verifyAndSettle({
    paymentSignatureHeader,
    endpoint: endpointConfig,
    method,
    canonicalUrl: fullUrl.toString(),
    rawBody,
    idempotencyKey,
  });

  if (!settled.ok) {
    sendError(res, settled.status, settled.code, settled.message, settled.status >= 500);
    return;
  }

  const { receipt, receiptHeaderB64 } = settled;
  let status = 200;
  let responseBody: Record<string, unknown>;

  if (pathname === "/v1/demo/simulate-failure") {
    // Settles then triggers on-chain refundPayment (REQ-006, ADR-0009)
    const refundRes = await client.refundPaymentOnChain(
      providerKey,
      receipt.payer,
      receipt.paymentId!,
      receipt.amount,
    );
    status = 502;
    responseBody = {
      status: "REFUNDED",
      error: {
        code: "ANE-E-5004",
        message:
          "Simulated downstream tool failure after payment settlement; full on-chain refund executed via AneAgentVault.refundPayment",
        retryable: true,
      },
      originalTxHash: receipt.txHash,
      refundTxHash: refundRes.txHash,
      refundBlockNumber: refundRes.blockNumber,
      refundedAmount: receipt.amount,
      assetSymbol: "tANE",
      payerVault: receipt.payer,
      intentId: receipt.intentId,
      paymentId: receipt.paymentId,
      disclaimer: SANDBOX_DISCLAIMER,
    };
  } else {
    const result = pathname === "/v1/demo/summarize" ? summarize(rawBody) : cleanData(rawBody);
    responseBody = {
      serviceId: DEMO_SERVICE_ID,
      endpoint: pathname,
      ...result,
      paidAmount: receipt.amount,
      assetSymbol: "tANE",
      txHash: receipt.txHash,
      intentId: receipt.intentId,
      sponsored: false,
      disclaimer: SANDBOX_DISCLAIMER,
    };
  }

  const responseHeaders = { "payment-response": receiptHeaderB64 };
  verifier.saveIdempotentResponse(idempotencyKey, {
    requestHash,
    status,
    headers: responseHeaders,
    body: responseBody,
    receipt,
  });
  sendJson(res, status, responseBody, responseHeaders);
}
