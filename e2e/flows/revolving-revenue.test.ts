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

// Earned revenue under a REVOLVING budget: verified revenue raises spendable again, a raw
// wash transfer does not, and the treasury ceiling bounds the rise (REQ-004, REQ-107, T6).
test("verified revenue revolves the budget up to its ceiling (REQ-004, REQ-107, T6)", async (t) => {
  const stack = await startSandboxStack(t);
  await setupFundedSession(stack, {
    fund: 1600n * ONE_TANE,
    cap: 100n * ONE_TANE,
    perTx: 100n * ONE_TANE,
    mode: "REVOLVING",
    ceiling: 150n * ONE_TANE,
    // Daily allowance defaults to the cap, which would mask the revolving rise; open it wide.
    daily: 1000n * ONE_TANE,
  });
  const { sandbox, client, contracts, vaultAddress, session } = stack;

  const peerOwner = new OwnerWallet(client, new SecretKey(PEER_OWNER_KEY));
  await fetch(`${sandbox.url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await signedClaimBody(client, PEER_OWNER_KEY),
  });
  const { vaultAddress: peerVault } = await peerOwner.ensureVaultDeployed(0n);
  await peerOwner.fundVault(peerVault, 1000n * ONE_TANE);
  const peerSession = new AgentSession({
    client,
    vaultAddress: peerVault,
    sessionKey: new SecretKey(PEER_SESSION_KEY),
  });
  await peerOwner.delegateSession(peerVault, peerSession.sessionAddress, {
    mode: "FIXED",
    allowanceCap: 500n * ONE_TANE,
    perTxLimit: 500n * ONE_TANE,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const payRevenue = async (amount: bigint, quoteTag: string) => {
    const peerIntent = peerSession.signSpendIntent({
      merchant: vaultAddress,
      amount,
      quoteId: keccak256Utf8(quoteTag),
      serviceIdHash: keccak256Utf8("peer-agent-service"),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      policyVersion: await client.getPolicyVersion(peerVault),
    });
    await client.settleSpendIntentOnChain(new SecretKey(DEPLOYER_KEY), peerIntent.intent, peerIntent.signature);
  };

  await t.test("a 16 tANE purchase drops spendable from the 100 tANE base", async () => {
    assert.equal(await client.getAvailableToSpend(vaultAddress), 100n * ONE_TANE);
    const paid = await session.purchase(`${sandbox.url}/v1/demo/summarize`, {
      method: "POST",
      body: JSON.stringify({ text: "revolving budget spend" }),
      maxPayment: 32n * ONE_TANE,
    });
    assert.equal(paid.status, 200);
    assert.equal(await client.getAvailableToSpend(vaultAddress), 84n * ONE_TANE);
  });

  await t.test("a raw 1,000 tANE wash transfer raises neither revenue nor spendable", async () => {
    const wash = await client.sendContractTx(
      new SecretKey(PEER_OWNER_KEY),
      contracts.aneTestToken,
      "transfer(address,uint256)",
      [vaultAddress, (1000n * ONE_TANE).toString()],
    );
    assert.ok(wash.txHash.startsWith("0x"));
    assert.equal((await client.getAccountingSummary(vaultAddress)).verifiedRevenue, 0n);
    assert.equal(await client.getAvailableToSpend(vaultAddress), 84n * ONE_TANE);
  });

  await t.test("60 tANE of verified revenue raises spendable again", async () => {
    await payRevenue(60n * ONE_TANE, "peer-revolving-job-001");
    assert.equal((await client.getAccountingSummary(vaultAddress)).verifiedRevenue, 60n * ONE_TANE);
    const avail = await client.getAvailableToSpend(vaultAddress);
    assert.ok(avail > 84n * ONE_TANE, `spendable rose with revenue, got ${avail}`);
  });

  await t.test("300 tANE more revenue is bounded by the 150 tANE ceiling", async () => {
    await payRevenue(300n * ONE_TANE, "peer-revolving-job-002");
    const avail = await client.getAvailableToSpend(vaultAddress);
    assert.ok(avail <= 150n * ONE_TANE, `spendable respects the ceiling, got ${avail}`);
  });
});
