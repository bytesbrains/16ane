import test from "node:test";
import assert from "node:assert/strict";
import {
  SecretKey,
  computeRequestHash,
  computeResourceHash,
  keccak256Utf8,
  privateKeyToAddress,
  type SpendIntent,
} from "../../packages/sdk-ts/src/index.ts";
import {
  DEPLOYER_KEY,
  ONE_TANE,
  OWNER_KEY,
  PEER_OWNER_KEY,
  encodeX402PaymentSignature,
  setupFundedSession,
  startSandboxStack,
} from "../harness.ts";

// The merchant verifies before it delivers: wrong merchant, underpayment, expiry, bad
// signature, and direct-settle proofs that don't match the chain are all refused (REQ-007, T4).
test("the merchant verifies every payment before delivering (REQ-007, T4)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, contracts, vaultAddress, session } = stack;
  const targetUrl = `${sandbox.url}/v1/demo/summarize`;
  const priceUrl = `${sandbox.url}/v1/demo/clean-data`;
  // Built, not inlined: gitleaks flags `"idempotency-key": "…"` literals as generic API keys.
  const idemKey = (tag: string) => `idem-${tag}`;

  const sign = async (overrides: { amount: bigint; quoteTag: string; merchant?: string; validBefore?: number }) => {
    return session.signSpendIntent({
      merchant: overrides.merchant ?? sandbox.providerAddress,
      amount: overrides.amount,
      quoteId: keccak256Utf8(overrides.quoteTag),
      serviceIdHash: keccak256Utf8("16ane-sandbox-reference-demo"),
      validBefore: overrides.validBefore ?? Math.floor(Date.now() / 1000) + 300,
      policyVersion: await client.getPolicyVersion(vaultAddress),
    });
  };
  const post = (url: string, body: string, paymentB64: string, idemKey: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idemKey,
        "payment-signature": paymentB64,
      },
      body,
    });
  const payloadFor = (
    signed: { intent: SpendIntent; signature: string },
    url: string,
    body: string,
    amount: bigint,
    txHash?: string,
  ) =>
    encodeX402PaymentSignature({
      asset: contracts.aneTestToken,
      amount,
      payTo: sandbox.providerAddress,
      intent: signed.intent,
      signature: signed.signature,
      resourceHash: computeResourceHash("POST", url),
      requestHash: computeRequestHash(body),
      ...(txHash === undefined ? {} : { txHash }),
    });

  await t.test("a valid payment settles and the receipt names payee, asset and amount", async () => {
    const body = JSON.stringify({ text: "merchant baseline" });
    const signed = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-ok-001" });
    const res = await post(targetUrl, body, payloadFor(signed, targetUrl, body, 16n * ONE_TANE), idemKey("merchant-ok"));
    assert.equal(res.status, 200);
    const receiptHeader = res.headers.get("payment-response");
    assert.ok(receiptHeader, "the merchant answers with a payment-response receipt");
    const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as {
      payTo: string;
      asset: string;
      amount: string;
      txHash: string;
    };
    assert.equal(receipt.payTo.toLowerCase(), sandbox.providerAddress.toLowerCase());
    assert.equal(receipt.asset.toLowerCase(), contracts.aneTestToken.toLowerCase());
    assert.equal(receipt.amount, (16n * ONE_TANE).toString());
    assert.ok(receipt.txHash.startsWith("0x"));
  });

  await t.test("an intent for the wrong merchant is rejected (400 ANE-E-4007)", async () => {
    const body = JSON.stringify({ text: "wrong merchant" });
    const signed = await sign({
      amount: 16n * ONE_TANE,
      quoteTag: "merchant-wrong-payto-001",
      merchant: "0x1111111111111111111111111111111111111111",
    });
    const res = await post(
      targetUrl,
      body,
      payloadFor(signed, targetUrl, body, 16n * ONE_TANE),
      idemKey("merchant-payto"),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4007");
  });

  await t.test("an underpaying intent is rejected (402 ANE-E-4008)", async () => {
    const body = JSON.stringify({ text: "underpay" });
    const signed = await sign({ amount: 1n * ONE_TANE, quoteTag: "merchant-underpay-001" });
    const res = await post(targetUrl, body, payloadFor(signed, targetUrl, body, 1n * ONE_TANE), idemKey("merchant-underpay"));
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4008");
  });

  await t.test("an expired intent is rejected (402 ANE-E-4003)", async () => {
    const body = JSON.stringify({ text: "expired" });
    const signed = await sign({
      amount: 16n * ONE_TANE,
      quoteTag: "merchant-expired-001",
      validBefore: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await post(targetUrl, body, payloadFor(signed, targetUrl, body, 16n * ONE_TANE), idemKey("merchant-expired"));
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4003");
  });

  await t.test("a malformed signature is rejected (401 ANE-E-4010)", async () => {
    const body = JSON.stringify({ text: "bad signature" });
    const signed = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-badsig-001" });
    const res = await post(
      targetUrl,
      body,
      encodeX402PaymentSignature({
        asset: contracts.aneTestToken,
        amount: 16n * ONE_TANE,
        payTo: sandbox.providerAddress,
        intent: signed.intent,
        signature: "0x1234",
        resourceHash: computeResourceHash("POST", targetUrl),
        requestHash: computeRequestHash(body),
      }),
      idemKey("merchant-badsig"),
    );
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4010");
  });

  await t.test("a direct txHash with no matching transfer is rejected (402 ANE-E-4009)", async () => {
    // A real mined transfer, but to a peer — not to the merchant — so no log matches.
    const peer = privateKeyToAddress(new SecretKey(PEER_OWNER_KEY));
    const { txHash: peerTx } = await client.sendContractTx(
      new SecretKey(OWNER_KEY),
      contracts.aneTestToken,
      "transfer(address,uint256)",
      [peer, (16n * ONE_TANE).toString()],
    );
    const body = JSON.stringify({ text: "direct wrong tx" });
    const signed = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-directx-001" });
    const res = await post(
      targetUrl,
      body,
      payloadFor(signed, targetUrl, body, 16n * ONE_TANE, peerTx),
      idemKey("merchant-directx"),
    );
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4009");
  });

  await t.test("a direct txHash from a different payment is rejected (402 ANE-E-4009)", async () => {
    const first = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-reuse-a-001" });
    const settled = await client.settleSpendIntentOnChain(new SecretKey(DEPLOYER_KEY), first.intent, first.signature);
    const body = JSON.stringify({ items: ["reuse"] });
    const second = await sign({ amount: 32n * ONE_TANE, quoteTag: "merchant-reuse-b-001" });
    const res = await post(
      priceUrl,
      body,
      payloadFor(second, priceUrl, body, 32n * ONE_TANE, settled.txHash),
      idemKey("merchant-reuse"),
    );
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4009");
  });

  await t.test("an unknown txHash is rejected as unverified (402 ANE-E-4009)", async () => {
    const body = JSON.stringify({ text: "unknown tx" });
    const signed = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-unknown-001" });
    const res = await post(
      targetUrl,
      body,
      payloadFor(signed, targetUrl, body, 16n * ONE_TANE, `0x${"ab".repeat(32)}`),
      idemKey("merchant-unknown"),
    );
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ANE-E-4009");
  });

  await t.test("an honestly direct-settled payment verifies and delivers", async () => {
    const body = JSON.stringify({ text: "honest direct" });
    const signed = await sign({ amount: 16n * ONE_TANE, quoteTag: "merchant-direct-ok-001" });
    const settled = await client.settleSpendIntentOnChain(
      new SecretKey(DEPLOYER_KEY),
      signed.intent,
      signed.signature,
    );
    const res = await post(
      targetUrl,
      body,
      payloadFor(signed, targetUrl, body, 16n * ONE_TANE, settled.txHash),
      idemKey("merchant-direct-ok"),
    );
    assert.equal(res.status, 200);
  });
});
