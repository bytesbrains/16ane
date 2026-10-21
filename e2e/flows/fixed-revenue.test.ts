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

// Earned revenue under a FIXED budget: verified incoming revenue must not raise what the
// agent can spend (REQ-004, T6). REVOLVING mode is covered in revolving-revenue.test.ts.
test("verified revenue does not raise a FIXED budget (REQ-004, T6)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack);
  const { sandbox, client, vaultAddress } = stack;

  await t.test("spendable is unchanged after 50 tANE of verified revenue arrives", async () => {
    const availBefore = await client.getAvailableToSpend(vaultAddress);

    // A peer agent vault pays 50 tANE of verified revenue to our vault.
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

    // Settle a 50 tANE payment from peerVault -> vaultAddress (triggers notifyVerifiedRevenue).
    const peerPolicyVer = await client.getPolicyVersion(peerVault);
    const peerIntent = peerSession.signSpendIntent({
      merchant: vaultAddress,
      amount: 50n * ONE_TANE,
      quoteId: keccak256Utf8("peer-to-agent-job-001"),
      serviceIdHash: keccak256Utf8("peer-agent-service"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion: peerPolicyVer,
    });
    await client.settleSpendIntentOnChain(new SecretKey(DEPLOYER_KEY), peerIntent.intent, peerIntent.signature);

    const availAfter = await client.getAvailableToSpend(vaultAddress);
    assert.equal(availAfter, availBefore);

    const summary = await client.getAccountingSummary(vaultAddress);
    assert.equal(summary.verifiedRevenue, 50n * ONE_TANE);
  });
});
