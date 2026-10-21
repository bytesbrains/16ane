import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession, OwnerWallet, SecretKey, keccak256Utf8 } from "../../packages/sdk-ts/src/index.ts";
import {
  DEPLOYER_KEY,
  ONE_TANE,
  PEER_OWNER_KEY,
  PEER_SESSION_KEY,
  setupFundedSession,
  signedClaimBody,
  startSandboxStack,
} from "../harness.ts";

// The whole acceptance path in one run: fund, buy, deliver, earn, return (REQ-011).
test("fund, buy, deliver, earn, return (REQ-011)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, owner, vaultAddress, session } = stack;
  // Test idempotency label (not a secret); the marker below silences the generic-api-key rule.
  const journeyIdemKey = "idem-journey-001"; //gitleaks:allow

  await t.test("fund: the vault holds the owner's 1,600 tANE", async () => {
    const summary = await client.getAccountingSummary(vaultAddress);
    assert.equal(summary.tokenBalance, 1600n * ONE_TANE);
    assert.equal(summary.ownerPrincipalDeposited, 1600n * ONE_TANE);
  });

  await t.test("buy and deliver: a paid call returns data with a verifiable receipt", async () => {
    const bought = await session.purchase<{
      summary: string;
      paidAmount: string;
      txHash: string;
    }>(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "Sixteen annas made a rupee." }),
      idempotencyKey: journeyIdemKey,
      maxPayment: 32n * ONE_TANE,
      verifyManifest: true,
      verifyReceiptOnChain: true,
    });
    assert.equal(bought.status, 200);
    assert.ok(bought.data.summary.length > 0, "the service delivered its result");
    assert.ok(bought.receipt?.txHash.startsWith("0x"));
  });

  await t.test("earn: a peer's 50 tANE job lands as verified revenue", async () => {
    const peerOwner = new OwnerWallet(client, new SecretKey(PEER_OWNER_KEY));
    await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await signedClaimBody(client, PEER_OWNER_KEY),
    });
    const { vaultAddress: peerVault } = await peerOwner.ensureVaultDeployed(0n);
    await peerOwner.fundVault(peerVault, 200n * ONE_TANE);
    const peerSession = new AgentSession({
      client,
      vaultAddress: peerVault,
      sessionKey: new SecretKey(PEER_SESSION_KEY),
    });
    await peerOwner.delegateSession(peerVault, peerSession.sessionAddress, {
      mode: "FIXED",
      allowanceCap: 100n * ONE_TANE,
      perTxLimit: 100n * ONE_TANE,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const peerIntent = peerSession.signSpendIntent({
      merchant: vaultAddress,
      amount: 50n * ONE_TANE,
      quoteId: keccak256Utf8("peer-journey-job-001"),
      serviceIdHash: keccak256Utf8("peer-agent-service"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion: await client.getPolicyVersion(peerVault),
    });
    await client.settleSpendIntentOnChain(new SecretKey(DEPLOYER_KEY), peerIntent.intent, peerIntent.signature);
    assert.equal((await client.getAccountingSummary(vaultAddress)).verifiedRevenue, 50n * ONE_TANE);
  });

  await t.test("return: revoke-and-sweep hands the remainder back to the owner", async () => {
    const ownerBefore = await client.getTokenBalance(owner.address);
    await owner.revokeAndSweep(vaultAddress, session.sessionAddress, owner.address);
    const summary = await client.getAccountingSummary(vaultAddress);
    assert.equal(summary.tokenBalance, 0n);
    assert.equal(summary.active, false);
    assert.ok((await client.getTokenBalance(owner.address)) > ownerBefore);
  });
});
