import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSession,
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  keccak256Utf8,
} from "../../packages/sdk-ts/src/index.ts";
import {
  DEPLOYER_KEY,
  ONE_TANE,
  SESSION_KEY,
  encodeX402PaymentSignature,
  setupFundedSession,
  startSandboxStack,
} from "../harness.ts";

// Refunds and revocation: automatic refund on downstream failure, in-flight intents die
// with revocation, and emergency revoke-and-sweep returns the remainder (REQ-005, REQ-008, T5, T10).
test("refund on failure, in-flight revoke, sweep the rest (REQ-005, REQ-008, T5, T10)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, owner, vaultAddress, session } = stack;

  await t.test("a downstream failure settles then automatically refunds 16 tANE (T10)", async () => {
    const summaryBeforeFail = await client.getAccountingSummary(vaultAddress);

    const failRes = await session.purchase<{
      status: string;
      originalTxHash: string;
      refundTxHash: string;
      refundedAmount: string;
      paymentId: string;
    }>(`${sandbox.url}/v1/demo/simulate-failure`, {
      method: "POST",
      body: JSON.stringify({ task: "trigger deterministic downstream failure" }),
    });
    assert.equal(failRes.status, 502);
    assert.equal(failRes.data.status, "REFUNDED");
    assert.ok(failRes.data.originalTxHash.startsWith("0x"));
    assert.ok(failRes.data.refundTxHash.startsWith("0x"));
    assert.equal(failRes.data.refundedAmount, (16n * ONE_TANE).toString());

    const paymentRec = await client.getPaymentRecord(vaultAddress, failRes.data.paymentId);
    assert.equal(paymentRec.amountPaid, 16n * ONE_TANE);
    assert.equal(paymentRec.amountRefunded, 16n * ONE_TANE);

    const summaryAfterFail = await client.getAccountingSummary(vaultAddress);
    // Refund restores cumulativeSpent back to pre-failure level and returns tokenBalance!
    assert.equal(summaryAfterFail.cumulativeSpent, summaryBeforeFail.cumulativeSpent);
    assert.equal(summaryAfterFail.tokenBalance, summaryBeforeFail.tokenBalance);
  });

  await t.test("an intent signed before revocation settles neither via server nor chain (T5)", async () => {
    // A second vault keeps this revocation from disturbing the main vault below.
    const { vaultAddress: vault2 } = await owner.ensureVaultDeployed(1n);
    await owner.fundVault(vault2, 200n * ONE_TANE);
    await owner.delegateSession(vault2, session.sessionAddress, {
      mode: "FIXED",
      allowanceCap: 100n * ONE_TANE,
      perTxLimit: 100n * ONE_TANE,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });

    const targetUrl = `${sandbox.url}/v1/demo/summarize`;
    const bodyStr = JSON.stringify({ text: "in-flight at revocation" });
    const session2 = new AgentSession({
      client,
      vaultAddress: vault2,
      sessionKey: new SecretKey(SESSION_KEY),
    });
    const signed = session2.signSpendIntent({
      merchant: sandbox.providerAddress,
      amount: 16n * ONE_TANE,
      quoteId: keccak256Utf8("quote-inflight-001"),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion: await client.getPolicyVersion(vault2),
    });

    await owner.revokeSession(vault2);

    const payloadB64 = encodeX402PaymentSignature({
      asset: (await client.resolveContracts()).aneTestToken,
      amount: 16n * ONE_TANE,
      payTo: sandbox.providerAddress,
      intent: signed.intent,
      signature: signed.signature,
      resourceHash: computeResourceHash("POST", targetUrl),
      requestHash: computeRequestHash(bodyStr),
    });
    // Named const, not an inline literal: gitleaks flags `"idempotency-key": "…"` as a generic API key.
    const inflightIdemKey = "idem-inflight-001";
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": inflightIdemKey,
        "payment-signature": payloadB64,
      },
      body: bodyStr,
    });
    assert.equal(res.status, 402);
    await assert.rejects(
      client.settleSpendIntentOnChain(new SecretKey(DEPLOYER_KEY), signed.intent, signed.signature),
    );
    assert.equal((await client.getAccountingSummary(vault2)).cumulativeSpent, 0n);
  });

  await t.test("emergency revokeAndSweep returns everything and ends the session", async () => {
    const ownerBalBeforeSweep = await client.getTokenBalance(owner.address);
    await owner.revokeAndSweep(vaultAddress, session.sessionAddress, owner.address);

    const summaryAfterSweep = await client.getAccountingSummary(vaultAddress);
    assert.equal(summaryAfterSweep.tokenBalance, 0n);
    assert.equal(summaryAfterSweep.active, false);

    const ownerBalAfterSweep = await client.getTokenBalance(owner.address);
    assert.ok(ownerBalAfterSweep > ownerBalBeforeSweep);

    await assert.rejects(
      () =>
        session.purchase(`${sandbox.url}/v1/demo/summarize`, {
          method: "POST",
          body: JSON.stringify({ text: "post-revocation spend attempt" }),
        }),
      /ANE-E-3001/,
    );
  });
});
