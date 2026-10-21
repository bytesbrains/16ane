import test from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_DISCLAIMER } from "../../packages/sdk-ts/src/index.ts";
import { ONE_TANE, OWNER_KEY, signedClaimBody, startSandboxStack } from "../harness.ts";

// Owner onboarding: faucet claim, cooldown, fund, delegate (REQ-002, REQ-003, REQ-012).
test("owner onboarding: claim, cooldown, fund, delegate (REQ-002, REQ-003, REQ-012)", async (t) => {
  const { sandbox, client, owner, vaultAddress, session } = await startSandboxStack(t);

  await t.test("faucet claim grants 16,000 tANE and states no cash value", async () => {
    const claimRes = await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await signedClaimBody(client, OWNER_KEY),
    });
    assert.equal(claimRes.status, 201);
    const claimBody = (await claimRes.json()) as {
      claimId: string;
      amount: string;
      disclaimer: string;
    };
    assert.equal(claimBody.amount, (16_000n * ONE_TANE).toString());
    assert.equal(claimBody.disclaimer, SANDBOX_DISCLAIMER);
  });

  await t.test("a second immediate claim for the same recipient is rejected with 429", async () => {
    const repeatClaim = await fetch(`${sandbox.url}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await signedClaimBody(client, OWNER_KEY),
    });
    assert.equal(repeatClaim.status, 429);
  });

  await t.test("owner funds the vault and delegates a FIXED session without sharing keys", async () => {
    await owner.fundVault(vaultAddress, 1600n * ONE_TANE);
    await owner.delegateSession(vaultAddress, session.sessionAddress, {
      mode: "FIXED",
      allowanceCap: 320n * ONE_TANE,
      perTxLimit: 64n * ONE_TANE,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });

    const summary = await client.getAccountingSummary(vaultAddress);
    assert.equal(summary.tokenBalance, 1600n * ONE_TANE);
    assert.equal(summary.ownerPrincipalDeposited, 1600n * ONE_TANE);
    assert.equal(summary.spendableNow, 320n * ONE_TANE);
  });
});
