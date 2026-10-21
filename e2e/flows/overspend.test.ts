import test from "node:test";
import assert from "node:assert/strict";
import {
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  keccak256Utf8,
} from "../../packages/sdk-ts/src/index.ts";
import {
  ONE_TANE,
  OWNER_KEY,
  encodeX402PaymentSignature,
  setupFundedSession,
  startSandboxStack,
} from "../harness.ts";

// Delegation under attack: overpriced endpoints, spoofed manifests, prompt-injected
// overspend intents and replayed proofs are all rejected (REQ-004, T1, T3, T4).
test("overspend, spoofed manifest and replayed intent are rejected (REQ-004, T1, T3, T4)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, contracts, vaultAddress, session } = stack;

  await t.test("the caller maxPayment guard blocks an overpriced endpoint before signing", async () => {
    await assert.rejects(
      () =>
        session.purchase(`${sandbox.url}/v1/demo/clean-data`, {
          method: "POST",
          body: JSON.stringify({ items: ["a"] }),
          maxPayment: 8n * ONE_TANE, // endpoint costs 32 tANE
        }),
      /ANE-E-3002/,
    );
  });

  await t.test("a spoofed manifest payTo mismatch is rejected before signing (T4)", async () => {
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
  });

  await t.test("a prompt-injected 500 tANE intent reverts on-chain without leaking detail (T1)", async () => {
    const targetUrl = `${sandbox.url}/v1/demo/summarize`;
    const bodyStr = JSON.stringify({ text: "overspend attempt" });
    const resourceHash = computeResourceHash("POST", targetUrl);
    const requestHash = computeRequestHash(bodyStr);
    const policyVersion = await client.getPolicyVersion(vaultAddress);

    const overspendSigned = session.signSpendIntent({
      merchant: sandbox.providerAddress,
      amount: 500n * ONE_TANE, // > 64 tANE per-tx and > 320 tANE cap
      quoteId: keccak256Utf8("quote-overspend-001"),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion,
    });
    const overspendPayloadB64 = encodeX402PaymentSignature({
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
  });

  await t.test("replaying a valid intent under a new idempotency key is a 409 (T3)", async () => {
    const targetUrl = `${sandbox.url}/v1/demo/summarize`;
    const bodyStr = JSON.stringify({ text: "overspend attempt" });
    const resourceHash = computeResourceHash("POST", targetUrl);
    const requestHash = computeRequestHash(bodyStr);
    const policyVersion = await client.getPolicyVersion(vaultAddress);
    const validSigned = session.signSpendIntent({
      merchant: sandbox.providerAddress,
      amount: 16n * ONE_TANE,
      quoteId: keccak256Utf8("quote-replay-test-001"),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion,
    });
    const validPayloadB64 = encodeX402PaymentSignature({
      asset: contracts.aneTestToken,
      amount: 16n * ONE_TANE,
      payTo: sandbox.providerAddress,
      intent: validSigned.intent,
      signature: validSigned.signature,
      resourceHash,
      requestHash,
    });

    // Named consts, not inline literals: gitleaks flags `"idempotency-key": "…"` as a generic API key.
    const firstIdemKey = "idem-replay-1";
    const secondIdemKey = "idem-replay-2";
    const firstUse = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": firstIdemKey,
        "payment-signature": validPayloadB64,
      },
      body: bodyStr,
    });
    assert.equal(firstUse.status, 200);

    const secondReplay = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": secondIdemKey,
        "payment-signature": validPayloadB64,
      },
      body: bodyStr,
    });
    assert.equal(secondReplay.status, 409);
  });
});
