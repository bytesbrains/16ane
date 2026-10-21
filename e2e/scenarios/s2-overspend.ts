import assert from "node:assert/strict";
import {
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  keccak256Utf8,
  type SpendIntent,
} from "../../packages/sdk-ts/src/index.ts";
import { ONE_TANE, OWNER_KEY, type SandboxStack } from "../harness.ts";

/** Base64 Payment-Signature header for a raw fetch against the sandbox (S2 threat checks). */
function encodePaymentSignature(params: {
  asset: string;
  amount: bigint;
  payTo: string;
  intent: SpendIntent;
  signature: string;
  resourceHash: string;
  requestHash: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "ane-vault-v1",
      network: "eip155:84532",
      accepted: {
        asset: params.asset,
        amount: params.amount.toString(),
        payTo: params.payTo,
      },
      payload: {
        ...params.intent,
        resourceHash: params.resourceHash,
        requestHash: params.requestHash,
        signature: params.signature,
      },
    }),
    "utf8",
  ).toString("base64");
}

/** S2: overspend, spoofed manifest, prompt-injected SpendIntent, replay (T1, T2, T6, T8). */
export async function runS2(stack: SandboxStack): Promise<void> {
  const { sandbox, client, contracts, vaultAddress, session } = stack;

  // 1. Caller maxPayment guard blocks overpriced endpoint before signing
  await assert.rejects(
    () =>
      session.purchase(`${sandbox.url}/v1/demo/clean-data`, {
        method: "POST",
        body: JSON.stringify({ items: ["a"] }),
        maxPayment: 8n * ONE_TANE, // endpoint costs 32 tANE
      }),
    /ANE-E-3002/,
  );

  // 2. Spoofed manifest payTo mismatch is rejected before signing (T8)
  const spoofedManifest = client.signServiceManifest(
    {
      schemaVersion: "16ane-manifest-v0",
      serviceId: "spoofed-service",
      name: "Spoofed Service",
      version: "0.1.0",
      network: "eip155:84532",
      chainId: 84532,
      payTo: "0x1111111111111111111111111111111111111111", // differs from server payTo
      tokenAddress: contracts.aneTestToken,
      tokenSymbol: "tANE",
      updatedAt: 1760860800,
      endpoints: [
        {
          id: "summarize",
          method: "POST",
          path: "/v1/demo/summarize",
          priceAmount: (16n * ONE_TANE).toString(),
          scheme: "ane-vault-v1",
        },
      ],
    },
    new SecretKey(OWNER_KEY),
    contracts.aneServiceDirectory,
  );

  await assert.rejects(
    () =>
      session.purchase(`${sandbox.url}/v1/demo/summarize`, {
        method: "POST",
        body: JSON.stringify({ text: "test spoof" }),
        manifest: spoofedManifest,
      }),
    /ANE-E-5003/,
  );

  // 3. Prompt-injected attempt to sign a 500 tANE SpendIntent (> 64 tANE maxPerTx & > 320 tANE cap) reverts on-chain (T1, T2)
  const targetUrl = `${sandbox.url}/v1/demo/summarize`;
  const bodyStr = JSON.stringify({ text: "overspend attempt" });
  const resourceHash = computeResourceHash("POST", targetUrl);
  const requestHash = computeRequestHash(bodyStr);
  const policyVersion = await client.getPolicyVersion(vaultAddress);

  const overspendSigned = session.signSpendIntent({
    merchant: sandbox.providerAddress,
    amount: 500n * ONE_TANE,
    quoteId: keccak256Utf8("quote-overspend-001"),
    serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
    validBefore: Math.floor(Date.now() / 1000) + 300,
    policyVersion,
  });
  const overspendPayloadB64 = encodePaymentSignature({
    asset: contracts.aneTestToken,
    amount: 500n * ONE_TANE,
    payTo: sandbox.providerAddress,
    intent: overspendSigned.intent,
    signature: overspendSigned.signature,
    resourceHash,
    requestHash,
  });

  const overspendRes = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": overspendPayloadB64,
    },
    body: bodyStr,
  });
  assert.equal(overspendRes.status, 402);
  const overspendErr = (await overspendRes.json()) as {
    error: { code: string; message: string; errorId?: string };
  };
  assert.equal(overspendErr.error.code, "ANE-E-4011");
  // The revert detail is logged server-side under errorId, never sent to the client (#52).
  assert.equal(overspendErr.error.message, "On-chain settlement failed");
  assert.match(overspendErr.error.errorId ?? "", /^[0-9a-f-]{36}$/);

  // 4. Replaying a valid signed SpendIntent with a new Idempotency-Key is rejected with 409 (T6)
  const validSigned = session.signSpendIntent({
    merchant: sandbox.providerAddress,
    amount: 16n * ONE_TANE,
    quoteId: keccak256Utf8("quote-replay-test-001"),
    serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
    validBefore: Math.floor(Date.now() / 1000) + 300,
    policyVersion,
  });
  const validPayloadB64 = encodePaymentSignature({
    asset: contracts.aneTestToken,
    amount: 16n * ONE_TANE,
    payTo: sandbox.providerAddress,
    intent: validSigned.intent,
    signature: validSigned.signature,
    resourceHash,
    requestHash,
  });

  const firstUse = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-replay-1",
      "payment-signature": validPayloadB64,
    },
    body: bodyStr,
  });
  assert.equal(firstUse.status, 200);

  const secondReplay = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-replay-2",
      "payment-signature": validPayloadB64,
    },
    body: bodyStr,
  });
  assert.equal(secondReplay.status, 409);
}
