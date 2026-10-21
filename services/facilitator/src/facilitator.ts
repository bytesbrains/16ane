// Canonical x402 facilitator handlers (ADR-0005, #18): POST /verify, POST /settle, GET /supported.
// Wire shapes follow coinbase/x402 `typescript/packages/core/src/types/{facilitator,payments}.ts`
// (checked 2026-10-21). Verdicts always answer HTTP 200 with the canonical body; 4xx/5xx are reserved
// for requests that cannot be evaluated (malformed JSON, unsupported scheme/network, gas policy).
//
// Trust model: the facilitator attests that a payment authorization is valid and settles it; it never
// sees the merchant's request, so resource/request binding stays the merchant's job at delivery time
// (AnePaymentVerifier.verifyAndSettle still checks it there). There are no per-agent or per-wallet
// count limits anywhere on this path (#61): the only limits are cost-based (fee ceiling, gas budget).
import type http from "node:http";
import {
  hashSpendIntent,
  hashTransferWithAuthorization,
  toChecksumAddress,
  type AneClient,
  type AneContractAddresses,
  type AnePaymentVerifier,
  type X402DecodedPayment,
} from "../../../packages/sdk-ts/src/index.ts";
import {
  refuseAboveFeeCeiling,
  RelayerGasBudgetExceededError,
  sendBudgetExhausted,
  type RelayerGasBudget,
} from "../../sandbox-server/src/gas-budget.ts";
import { readRequestBody, sendJson } from "../../sandbox-server/src/http.ts";

export const ZERO_TX_HASH = "0x" + "00".repeat(32);

export interface FacilitatorContext {
  client: AneClient;
  verifier: AnePaymentVerifier;
  contracts: AneContractAddresses;
  relayerAddress: string;
  gasBudget: RelayerGasBudget;
  /** Refuse to settle while the network's gas price is above this (ADR-0006). Unset: no ceiling. */
  maxFeeWei?: bigint;
  maxBodyBytes: number;
}

export interface ParsedFacilitatorRequest {
  paymentPayload: {
    accepted: { scheme: string; network: string; asset: string; amount: string; payTo: string };
    payload: Record<string, unknown>;
  };
  paymentRequirements: { scheme: string; network: string; asset: string; amount: string; payTo: string };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAddress = (v: unknown) => typeof v === "string" && ADDRESS.test(v);
const isBytes32 = (v: unknown) => typeof v === "string" && BYTES32.test(v);
const isUintString = (v: unknown) => typeof v === "string" && UINT.test(v);
const isSafeUint = (v: unknown) =>
  (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
  (typeof v === "string" && UINT.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));

function checkPayloadShape(scheme: string, payload: unknown): string | undefined {
  if (!isObject(payload)) return "paymentPayload.payload must be an object";
  if (scheme === "ane-vault-v1") {
    const p = payload;
    if (!isAddress(p.vault)) return "payload.vault must be an address";
    if (!isAddress(p.merchant)) return "payload.merchant must be an address";
    if (!isUintString(p.amount)) return "payload.amount must be a whole number of base units";
    if (!isBytes32(p.quoteId)) return "payload.quoteId must be 32 bytes of hex";
    if (!isBytes32(p.serviceIdHash)) return "payload.serviceIdHash must be 32 bytes of hex";
    if (!isSafeUint(p.validAfter)) return "payload.validAfter must be a whole number";
    if (!isSafeUint(p.validBefore)) return "payload.validBefore must be a whole number";
    if (!isBytes32(p.nonce)) return "payload.nonce must be 32 bytes of hex";
    if (!isSafeUint(p.policyVersion)) return "payload.policyVersion must be a whole number";
    if (typeof p.signature !== "string" || !SIGNATURE.test(p.signature)) {
      return "payload.signature must be 65 bytes of hex";
    }
    if (p.txHash !== undefined && !isBytes32(p.txHash)) return "payload.txHash must be 32 bytes of hex";
    return undefined;
  }
  if (scheme === "exact") {
    const p = payload;
    if (!isAddress(p.from)) return "payload.from must be an address";
    if (!isAddress(p.to)) return "payload.to must be an address";
    if (!isUintString(p.value)) return "payload.value must be a whole number of base units";
    if (!isSafeUint(p.validAfter)) return "payload.validAfter must be a whole number";
    if (!isSafeUint(p.validBefore)) return "payload.validBefore must be a whole number";
    if (!isBytes32(p.nonce)) return "payload.nonce must be 32 bytes of hex";
    if (typeof p.signature !== "string" || !SIGNATURE.test(p.signature)) {
      return "payload.signature must be 65 bytes of hex";
    }
    return undefined;
  }
  return `unsupported x402 scheme: ${scheme}`;
}

function checkRequirementsShape(req: unknown): string | undefined {
  if (!isObject(req)) return "paymentRequirements must be an object";
  if (req.scheme !== "ane-vault-v1" && req.scheme !== "exact") {
    return `unsupported x402 scheme: ${String(req.scheme)}`;
  }
  if (typeof req.network !== "string" || !req.network) return "paymentRequirements.network must be a CAIP-2 id";
  if (!isAddress(req.asset)) return "paymentRequirements.asset must be an address";
  if (!isUintString(req.amount)) return "paymentRequirements.amount must be a whole number of base units";
  if (!isAddress(req.payTo)) return "paymentRequirements.payTo must be an address";
  if (typeof req.maxTimeoutSeconds !== "number" || !Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
    return "paymentRequirements.maxTimeoutSeconds must be a positive whole number";
  }
  return undefined;
}

/** Parses and shape-checks a canonical Verify/Settle request body. Reasons are safe for clients. */
export function parseFacilitatorRequest(
  body: unknown,
): { ok: true; request: ParsedFacilitatorRequest } | { ok: false; reason: string } {
  if (!isObject(body)) return { ok: false, reason: "the request body must be a JSON object" };
  if (body.x402Version !== 2) return { ok: false, reason: "x402Version must be 2" };
  const requirementsProblem = checkRequirementsShape(body.paymentRequirements);
  if (requirementsProblem) return { ok: false, reason: requirementsProblem };
  const requirements = body.paymentRequirements as ParsedFacilitatorRequest["paymentRequirements"];
  if (!isObject(body.paymentPayload)) return { ok: false, reason: "paymentPayload must be an object" };
  const payment = body.paymentPayload as Record<string, unknown>;
  if (payment.x402Version !== 2) return { ok: false, reason: "paymentPayload.x402Version must be 2" };
  if (!isObject(payment.accepted)) return { ok: false, reason: "paymentPayload.accepted must be an object" };
  const accepted = payment.accepted as Record<string, unknown>;
  for (const field of ["scheme", "network", "asset", "payTo"] as const) {
    const a = accepted[field];
    const r = requirements[field];
    const same =
      typeof a === "string" && typeof r === "string"
        ? (field === "asset" || field === "payTo" ? a.toLowerCase() === r.toLowerCase() : a === r)
        : false;
    if (!same) return { ok: false, reason: `paymentPayload.accepted.${field} does not match the requirements` };
  }
  if (!isUintString(accepted.amount) || BigInt(accepted.amount) < BigInt(requirements.amount)) {
    return { ok: false, reason: "paymentPayload.accepted.amount is below the required amount" };
  }
  const payloadProblem = checkPayloadShape(requirements.scheme, payment.payload);
  if (payloadProblem) return { ok: false, reason: payloadProblem };
  return {
    ok: true,
    request: {
      paymentPayload: {
        accepted: accepted as ParsedFacilitatorRequest["paymentPayload"]["accepted"],
        payload: payment.payload as Record<string, unknown>,
      },
      paymentRequirements: requirements,
    },
  };
}

function toDecoded(request: ParsedFacilitatorRequest): X402DecodedPayment {
  return {
    x402Version: 2,
    scheme: request.paymentRequirements.scheme as "ane-vault-v1" | "exact",
    network: request.paymentRequirements.network as "eip155:84532" | "eip155:31337",
    accepted: {
      asset: request.paymentPayload.accepted.asset,
      amount: request.paymentPayload.accepted.amount,
      payTo: request.paymentPayload.accepted.payTo,
    },
    payload: request.paymentPayload.payload,
  };
}

function payerOf(scheme: string, payload: Record<string, unknown>): string | undefined {
  const raw = scheme === "ane-vault-v1" ? payload.vault : payload.from;
  return typeof raw === "string" ? toChecksumAddress(raw) : undefined;
}

// Proof ids a settle may already have consumed, for the idempotent-retry receipt lookup.
function receiptIds(scheme: string, payload: Record<string, unknown>, chainId: number, asset: string): string[] {
  try {
    if (scheme === "ane-vault-v1") {
      const p = payload as unknown as Parameters<typeof hashSpendIntent>[1];
      const { structHash, paymentId } = hashSpendIntent(chainId, p);
      const ids = [paymentId, structHash];
      if (typeof p.txHash === "string") ids.push(p.txHash);
      return ids;
    }
    const p = payload as unknown as Parameters<typeof hashTransferWithAuthorization>[2];
    return [hashTransferWithAuthorization(chainId, asset, p).structHash];
  } catch {
    return [];
  }
}

export function supportedBody(ctx: FacilitatorContext): Record<string, unknown> {
  const network = `eip155:${ctx.client.chainId}`;
  const kinds = ["ane-vault-v1", "exact"].map((scheme) => ({
    x402Version: 2,
    scheme,
    network,
    extra: { asset: ctx.contracts.aneTestToken, assetSymbol: "tANE" },
  }));
  return { x402Version: 2, kinds, extensions: [], signers: { [network]: [ctx.relayerAddress] } };
}

async function readParsedBody(
  ctx: FacilitatorContext,
  req: http.IncomingMessage,
): Promise<{ ok: true; request: ParsedFacilitatorRequest } | { ok: false; reason: string }> {
  const rawBody = await readRequestBody(req, ctx.maxBodyBytes);
  return parseFacilitatorRequest(rawBody ? JSON.parse(rawBody) : {});
}

function servingFailure(ctx: FacilitatorContext, request: ParsedFacilitatorRequest): string | undefined {
  const want = `eip155:${ctx.client.chainId}`;
  if (request.paymentRequirements.network !== want) {
    return `this facilitator serves ${want}, not ${request.paymentRequirements.network}`;
  }
  if (request.paymentRequirements.asset.toLowerCase() !== ctx.contracts.aneTestToken.toLowerCase()) {
    return `this facilitator settles ${ctx.contracts.aneTestToken} (tANE), not ${request.paymentRequirements.asset}`;
  }
  return undefined;
}

export async function handleVerify(
  ctx: FacilitatorContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const parsed = await readParsedBody(ctx, req);
  if (!parsed.ok) {
    sendJson(res, 400, { isValid: false, invalidReason: "ANE-E-4001", invalidMessage: parsed.reason });
    return;
  }
  const request = parsed.request;
  const unsupported = servingFailure(ctx, request);
  if (unsupported) {
    sendJson(res, 400, { isValid: false, invalidReason: "ANE-E-4001", invalidMessage: unsupported });
    return;
  }
  const endpoint = {
    serviceId: "x402-facilitator",
    priceAmount: request.paymentRequirements.amount,
    payTo: request.paymentRequirements.payTo,
    assetAddress: request.paymentRequirements.asset,
    network: `eip155:${ctx.client.chainId}` as "eip155:84532" | "eip155:31337",
  };
  const verdict = await ctx.verifier.verifyPayment({ decoded: toDecoded(request), endpoint });
  if (verdict.valid) {
    sendJson(res, 200, { isValid: true, payer: verdict.payer });
    return;
  }
  sendJson(res, 200, {
    isValid: false,
    invalidReason: verdict.code,
    invalidMessage: verdict.message,
    payer: payerOf(request.paymentRequirements.scheme, request.paymentPayload.payload),
  });
}

export async function handleSettle(
  ctx: FacilitatorContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const network = `eip155:${ctx.client.chainId}`;
  const failed = (status: number, reason: string, message: string, payer?: string) =>
    sendJson(res, status, {
      success: false,
      errorReason: reason,
      errorMessage: message,
      transaction: ZERO_TX_HASH,
      network,
      ...(payer === undefined ? {} : { payer }),
    });
  const parsed = await readParsedBody(ctx, req);
  if (!parsed.ok) {
    failed(400, "ANE-E-4001", parsed.reason);
    return;
  }
  const request = parsed.request;
  const unsupported = servingFailure(ctx, request);
  if (unsupported) {
    failed(400, "ANE-E-4001", unsupported);
    return;
  }
  if (
    await refuseAboveFeeCeiling(
      (m, p) => ctx.client.rpcCall(m, p),
      ctx.maxFeeWei,
      res,
      "settle the payment yourself with your own gas",
    )
  ) {
    return;
  }
  const endpoint = {
    serviceId: "x402-facilitator",
    priceAmount: request.paymentRequirements.amount,
    payTo: request.paymentRequirements.payTo,
    assetAddress: request.paymentRequirements.asset,
    network: network as "eip155:84532" | "eip155:31337",
  };
  const payer = payerOf(request.paymentRequirements.scheme, request.paymentPayload.payload);
  const settled = await ctx.verifier.settleDecoded({
    decoded: toDecoded(request),
    endpoint,
    preflight: { simulate: true, requireRegisteredVault: true },
  });
  if (settled.ok) {
    sendJson(res, 200, {
      success: true,
      payer: settled.receipt.payer,
      transaction: settled.receipt.txHash,
      network: settled.receipt.network,
      extra: { receipt: settled.receipt },
    });
    return;
  }
  if (settled.cause instanceof RelayerGasBudgetExceededError) {
    sendBudgetExhausted(res, settled.cause, "settle the payment yourself with your own gas");
    return;
  }
  if (settled.code === "ANE-E-4005") {
    // An honest retry after a lost response: the proof is consumed, so hand back the stored receipt
    // instead of failing a payment that already settled. Still in flight: nothing stored yet, retry.
    for (const id of receiptIds(
      request.paymentRequirements.scheme,
      request.paymentPayload.payload,
      ctx.client.chainId,
      request.paymentRequirements.asset,
    )) {
      const receipt = ctx.verifier.getReceipt(id);
      if (receipt) {
        sendJson(res, 200, {
          success: true,
          payer: receipt.payer,
          transaction: receipt.txHash,
          network: receipt.network,
          extra: { receipt, replayed: true },
        });
        return;
      }
    }
  }
  failed(200, settled.code, settled.message, payer);
}
